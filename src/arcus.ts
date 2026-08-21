import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

export interface BlessedHostInfo {
  version: string
  tag: string
  fleetVersion: string
  manifestPath: string
  targetKey: string
  binaryName: string
  asset: {
    filename: string
    url: string
    sha256: string
  }
}

export function resolveArcusTargetKey(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "darwin") {
    if (arch === "arm64" || arch === "x64") return `darwin-${arch}`
  } else if (platform === "linux") {
    if (arch === "x64" || arch === "arm64") return `linux-${arch}`
  } else if (platform === "win32") {
    if (arch === "x64") return "win32-x64"
    if (arch === "arm64") return "win32-arm64"
  }
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}`)
  }
  throw new Error(`Unsupported architecture for ${platform}: ${arch}`)
}

export function parseBlessedHostManifest(blessedDoc: any, manifestDoc: any, targetKey: string): BlessedHostInfo {
  const host = blessedDoc?.host?.opencode
  const manifestPath = host?.manifest

  if (!host || !manifestPath || typeof manifestPath !== "string") {
    throw new Error(
      `OpenCode host is not blessed or manifest is null in arcus-blessed-plugins.json (blessed_version: ${host?.blessed_version ?? "unknown"})`
    )
  }

  const blessedVersion = host.blessed_version ?? manifestDoc?.version
  if (!blessedVersion) {
    throw new Error("Missing version in blessed host specification")
  }

  const targetMatrix = manifestDoc?.daemon?.target_matrix
  if (!targetMatrix || typeof targetMatrix !== "object") {
    throw new Error("Manifest is missing daemon.target_matrix specification")
  }

  const targetSpec = targetMatrix[targetKey]
  if (!targetSpec) {
    const available = Object.keys(targetMatrix).join(", ")
    throw new Error(
      `Target platform '${targetKey}' not found in manifest daemon.target_matrix (available: ${available || "none"})`
    )
  }

  const asset = targetSpec.asset
  if (!asset || !asset.url || !asset.sha256 || !asset.filename) {
    throw new Error(`Target '${targetKey}' is missing valid asset declaration (url, filename, sha256)`)
  }

  return {
    version: blessedVersion,
    tag: `v${blessedVersion}`,
    fleetVersion: blessedDoc?.fleet_version ?? "unknown",
    manifestPath,
    targetKey,
    binaryName: targetSpec.binary_name ?? (targetKey.startsWith("win32") ? "opencode.exe" : "opencode"),
    asset: {
      filename: asset.filename,
      url: asset.url,
      sha256: asset.sha256,
    },
  }
}

export async function findArcusRoot(searchBaseDirs: string[]): Promise<string | null> {
  for (const dir of searchBaseDirs) {
    try {
      const blessedFile = path.join(dir, "arcus-blessed-plugins.json")
      await fs.access(blessedFile)
      return dir
    } catch {
      // continue search
    }
  }
  return null
}

export async function loadBlessedAndManifest(
  arcusDirOrUrl?: string,
  searchBaseDirs: string[] = []
): Promise<{ blessed: any; manifest: any; manifestRelativePath: string }> {
  let blessed: any
  let arcusDir: string | null = null

  if (arcusDirOrUrl && !arcusDirOrUrl.startsWith("http://") && !arcusDirOrUrl.startsWith("https://")) {
    const blessedPath = arcusDirOrUrl.endsWith(".json")
      ? arcusDirOrUrl
      : path.join(arcusDirOrUrl, "arcus-blessed-plugins.json")
    const raw = await fs.readFile(blessedPath, "utf8")
    blessed = JSON.parse(raw)
    arcusDir = path.dirname(blessedPath)
  } else {
    arcusDir = await findArcusRoot(searchBaseDirs)
    if (arcusDir) {
      const blessedPath = path.join(arcusDir, "arcus-blessed-plugins.json")
      const raw = await fs.readFile(blessedPath, "utf8")
      blessed = JSON.parse(raw)
    } else {
      // Remote fallback via raw GitHub
      const url = "https://raw.githubusercontent.com/rustybret/arcus/main/arcus-blessed-plugins.json"
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Failed to fetch remote arcus-blessed-plugins.json: HTTP ${res.status}`)
      }
      blessed = await res.json()
    }
  }

  const manifestPath = blessed?.host?.opencode?.manifest
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new Error(
      `OpenCode host manifest is null or missing in arcus-blessed-plugins.json (hold active / not blessed)`
    )
  }

  let manifest: any
  if (arcusDir) {
    const fullPath = path.join(arcusDir, manifestPath)
    const raw = await fs.readFile(fullPath, "utf8")
    manifest = JSON.parse(raw)
  } else {
    const url = `https://raw.githubusercontent.com/rustybret/arcus/main/${manifestPath}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch manifest from ${url}: HTTP ${res.status}`)
    }
    manifest = await res.json()
  }

  return { blessed, manifest, manifestRelativePath: manifestPath }
}

export async function downloadAndVerifyAsset(url: string, expectedSha256: string, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const res = await fetch(url, {
    headers: {
      "User-Agent": "orw-downloader",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    redirect: "follow",
  })

  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const actualSha256 = createHash("sha256").update(buffer).digest("hex")

  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA256 checksum mismatch for ${url}:\n  Expected: ${expectedSha256}\n  Actual:   ${actualSha256}\nFail-closed.`
    )
  }

  await fs.writeFile(outPath, buffer)
}

export async function extractBinaryFromArchive(archivePath: string, binaryName: string, destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })

  if (archivePath.endsWith(".zip")) {
    await execCommand(["unzip", "-q", "-o", archivePath, "-d", destDir])
  } else {
    await execCommand(["tar", "-xzf", archivePath, "-C", destDir])
  }

  const binaryPath = path.join(destDir, binaryName)
  try {
    await fs.access(binaryPath)
  } catch {
    throw new Error(`Extracted archive did not contain ${binaryName} at archive root (${archivePath})`)
  }

  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755)
  }

  return binaryPath
}

async function execCommand(cmd: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore" })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command '${cmd.join(" ")}' exited with code ${code}`))
    })
  })
}
