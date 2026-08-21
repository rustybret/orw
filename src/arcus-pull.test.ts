import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  downloadAndVerifyAsset,
  extractBinaryFromArchive,
  parseBlessedHostManifest,
  resolveArcusTargetKey,
} from "./arcus"

describe("ORW Arcus binary download & verification engine", () => {
  describe("#given platform and architecture", () => {
    it("#then resolves canonical 5-target matrix keys correctly", () => {
      expect(resolveArcusTargetKey("darwin", "arm64")).toBe("darwin-arm64")
      expect(resolveArcusTargetKey("darwin", "x64")).toBe("darwin-x64")
      expect(resolveArcusTargetKey("linux", "x64")).toBe("linux-x64")
      expect(resolveArcusTargetKey("linux", "arm64")).toBe("linux-arm64")
      expect(resolveArcusTargetKey("win32", "x64")).toBe("win32-x64")
    })

    it("#then throws for unsupported platforms", () => {
      expect(() => resolveArcusTargetKey("freebsd", "x64")).toThrow(/Unsupported platform/i)
      expect(() => resolveArcusTargetKey("darwin", "ia32")).toThrow(/Unsupported architecture/i)
    })
  })

  describe("#given arcus-blessed-plugins.json and manifest", () => {
    it("#then extracts blessed host metadata and target matrix asset", () => {
      const blessed = {
        schema_version: 1,
        fleet_version: "0.2026.08.3",
        host: {
          opencode: {
            blessed_version: "1.18.21+ucs.1",
            manifest: "manifests/opencode/v1.18.21+ucs.1.json",
          },
        },
      }

      const manifest = {
        name: "opencode",
        version: "1.18.21+ucs.1",
        daemon: {
          target_matrix: {
            "darwin-arm64": {
              binary_name: "opencode",
              asset: {
                filename: "opencode-darwin-arm64.tar.gz",
                url: "https://example.com/opencode-darwin-arm64.tar.gz",
                sha256: "20fccd0db1a14b821756d93b63d94948b1db2e447e865d0c022085426809a6e8",
              },
            },
          },
        },
      }

      const parsed = parseBlessedHostManifest(blessed, manifest, "darwin-arm64")
      expect(parsed.version).toBe("1.18.21+ucs.1")
      expect(parsed.tag).toBe("v1.18.21+ucs.1")
      expect(parsed.binaryName).toBe("opencode")
      expect(parsed.asset.filename).toBe("opencode-darwin-arm64.tar.gz")
      expect(parsed.asset.sha256).toBe("20fccd0db1a14b821756d93b63d94948b1db2e447e865d0c022085426809a6e8")
    })

    it("#then fails closed if host manifest is null or unblessed", () => {
      const blessed = {
        schema_version: 1,
        host: {
          opencode: {
            blessed_version: "1.18.21+ucs.1",
            manifest: null,
          },
        },
      }
      expect(() => parseBlessedHostManifest(blessed, null, "darwin-arm64")).toThrow(/not blessed or manifest is null/i)
    })
  })

  describe("#given downloaded archive data and expected SHA256", () => {
    it("#then verifies matching checksum cleanly", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orw-test-"))
      try {
        const payload = Buffer.from("mock-binary-payload-data-for-testing")
        const expectedSha = createHash("sha256").update(payload).digest("hex")
        const archiveFile = path.join(tmpDir, "archive.tar.gz")

        // Mock fetch with custom handler
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => payload.buffer,
        })) as any

        try {
          await downloadAndVerifyAsset("https://example.com/archive.tar.gz", expectedSha, archiveFile)
          const written = await fs.readFile(archiveFile)
          expect(written.equals(payload)).toBe(true)
        } finally {
          globalThis.fetch = originalFetch
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    })

    it("#then throws fail-closed on SHA256 mismatch", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orw-test-"))
      try {
        const payload = Buffer.from("tampered-binary-data")
        const archiveFile = path.join(tmpDir, "tampered.tar.gz")

        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => payload.buffer,
        })) as any

        try {
          await expect(
            downloadAndVerifyAsset("https://example.com/tampered.tar.gz", "0000000000000000000000000000000000000000000000000000000000000000", archiveFile)
          ).rejects.toThrow(/SHA256 checksum mismatch/i)
        } finally {
          globalThis.fetch = originalFetch
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    })
  })
})
