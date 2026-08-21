#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  downloadAndVerifyAsset,
  extractBinaryFromArchive,
  loadBlessedAndManifest,
  parseBlessedHostManifest,
  resolveArcusTargetKey,
} from "./arcus";

type RawCfg = {
  release_repo: string;
  source_repo: string;
  work_repo: string;
  base_branch: string;
  branches: string[];
  runtime_dir?: string;
  poll_minutes: number;
  agent: string;
  model: string;
  opencode_bin: string;
  prompt_path?: string;
  desktop_target: string;
  install_cli: boolean;
  install_desktop: boolean;
  notify_timeout: number;
  git_origin: string;
};

type Cfg = Omit<RawCfg, "runtime_dir" | "prompt_path"> & {
  runtime_dir: string;
  prompt_path: string;
  config_file: string;
  config_dir: string;
};

type Cli = {
  cmd: string;
  positionals: string[];
  configPath?: string;
  force: boolean;
  help: boolean;
  waitForOpenCode: boolean;
};

type IntegrationSource = {
  label: string;
  repo: string;
  fetchRef: string;
  fetch: string;
  merge: string;
};

type State = {
  tag?: string;
  branch?: string;
  release_url?: string;
  cli?: string;
  app?: string;
  log?: string;
  at?: string;
  source?: string;
  sha256?: string;
  manifest?: string;
  fleet_version?: string;
};

type OpenCodeProcess = {
  pid: number;
  command: string;
};

type ExecInput = {
  cwd?: string;
  log?: string;
  env?: Record<string, string>;
  printStdout?: boolean;
  printStderr?: boolean;
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@cortexkit/orw";
const configFileName = "orw.config.json";
const legacyConfigFileName = "config.json";
const bundledPrompt = path.join(packageRoot, "prompt.txt");
const launch = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "ai.opencode.release-watch.plist",
);
const label = "ai.opencode.release-watch";

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help || cli.cmd === "help") return printHelp();

  if (cli.cmd === "init") return init(cli);
  if (cli.cmd === "uninstall-launchd") return uninstallLaunchd();
  if (cli.cmd === "launchd" && cli.positionals[1] === "uninstall" && cli.positionals.length === 2) {
    return uninstallLaunchd();
  }

  if (!needsConfig(cli)) return unknown(cli);

  const cfg = await load(cli.configPath);
  if (cli.cmd === "install-launchd") return installLaunchd(cfg);
  if (cli.cmd === "launchd" && cli.positionals[1] === "install") return installLaunchd(cfg);
  if (cli.cmd === "install-ready") return installReady(cfg, { waitForOpenCode: cli.waitForOpenCode });
  if (cli.cmd === "install-when-closed") return installWhenClosed(cfg);
  if (cli.cmd === "pull" || cli.cmd === "pull-arcus") return pull(cfg, cli.force);
  if (cli.cmd === "preview") return preview(cfg);
  if (cli.cmd === "status") return status(cfg);
  if (cli.cmd === "check") return check(cfg, cli.force);
}

function parseCli(rawArgs: string[]): Cli {
  const args = rawArgs.map(norm);
  const positionals: string[] = [];
  let configPath: string | undefined;
  let force = false;
  let help = false;
  let waitForOpenCode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      configPath = args[++i];
      if (!configPath) throw new Error(`${arg} requires a path`);
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--wait-for-opencode") {
      waitForOpenCode = true;
      continue;
    }
    positionals.push(arg);
  }

  return {
    cmd: positionals[0] ?? "check",
    positionals,
    configPath,
    force,
    help,
    waitForOpenCode,
  };
}

function needsConfig(cli: Cli) {
  if (cli.cmd === "check") return cli.positionals.length <= 1;
  if (cli.cmd === "pull" || cli.cmd === "pull-arcus") return cli.positionals.length <= 1;
  if (cli.cmd === "preview") return cli.positionals.length === 1;
  if (cli.cmd === "status") return cli.positionals.length === 1;
  if (cli.cmd === "install-ready") return cli.positionals.length === 1;
  if (cli.cmd === "install-when-closed") return cli.positionals.length === 1;
  if (cli.cmd === "install-launchd") return cli.positionals.length === 1;
  return cli.cmd === "launchd" && cli.positionals[1] === "install" && cli.positionals.length === 2;
}

function unknown(cli: Cli) {
  process.stderr.write(`Unknown command: ${cli.positionals.join(" ") || cli.cmd}\n\n`);
  process.stderr.write(helpText());
  process.exitCode = 1;
}

function printHelp() {
  process.stdout.write(helpText());
}

function helpText() {
  return `OpenCode Release Watch\n\nUsage:\n  orw [--config <path>] [command] [options]\n  orw --help\n\nCommands:\n  init                  Create orw.config.json in the current directory\n  preview               Print the integration prompt for the latest release\n  pull                  Download and install verified OpenCode binary from Arcus\n  check                 Build the latest release if needed; default command\n  status                Print the last successful build/install state\n  install-ready         Install the last verified artifacts\n  install-when-closed   Wait for OpenCode to quit, then install\n  launchd install       Install the macOS launchd scheduler\n  launchd uninstall     Remove the macOS launchd scheduler\n\nOptions:\n  -c, --config <path>       Use a specific config file\n  --force                   Rebuild or re-download even if already processed\n  --wait-for-opencode       With install-ready, wait until OpenCode quits\n  -h, --help                Show this help\n`;
}

async function load(configPath?: string) {
  const file = await resolveConfigPath(configPath);
  const configDir = path.dirname(file);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<RawCfg>;
  const releaseRepo = raw.release_repo ?? "anomalyco/opencode";
  return {
    release_repo: releaseRepo,
    source_repo: abs(raw.source_repo ?? "./opencode", configDir),
    work_repo: abs(raw.work_repo ?? "./.orw/repo/opencode-build", configDir),
    base_branch: raw.base_branch ?? "dev",
    branches: raw.branches ?? [],
    runtime_dir: abs(raw.runtime_dir ?? ".", configDir),
    poll_minutes: raw.poll_minutes ?? 30,
    agent: raw.agent ?? "build",
    model: raw.model ?? "openai/gpt-5.5-fast",
    opencode_bin: raw.opencode_bin ?? "opencode",
    prompt_path: raw.prompt_path ? abs(raw.prompt_path, configDir) : bundledPrompt,
    desktop_target: abs(raw.desktop_target ?? defaultDesktopTarget(), configDir),
    install_cli: raw.install_cli ?? true,
    install_desktop: raw.install_desktop ?? defaultInstallDesktop(),
    notify_timeout: raw.notify_timeout ?? 120,
    git_origin: raw.git_origin ?? `https://github.com/${releaseRepo}.git`,
    config_file: file,
    config_dir: configDir,
  };
}

async function resolveConfigPath(configPath?: string) {
  if (configPath) return abs(configPath, process.cwd());

  const preferred = path.join(process.cwd(), configFileName);
  if (await exists(preferred)) return preferred;

  const legacy = path.join(process.cwd(), legacyConfigFileName);
  if (await exists(legacy)) return legacy;

  throw new Error(
    `No ${configFileName} found in ${process.cwd()}. Run \`bunx ${packageName} init\` first.`,
  );
}

function abs(input: string, base = process.cwd()) {
  const next = input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : input;
  if (path.isAbsolute(next)) return next;
  return path.resolve(base, next);
}

async function init(cli: Cli) {
  const file = cli.configPath
    ? abs(cli.configPath, process.cwd())
    : path.join(process.cwd(), configFileName);
  if (!cli.force && await exists(file)) {
    throw new Error(`${file} already exists. Use --force to overwrite it.`);
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(initConfig(), null, 2) + "\n");
  out(`Created ${file}`);
  out("Edit branches and source_repo, then run:");
  const configFlag = cli.configPath ? ` --config ${file}` : "";
  out(`  bunx ${packageName}${configFlag} preview`);
}

function initConfig(): RawCfg & { runtime_dir: string } {
  return {
    release_repo: "anomalyco/opencode",
    git_origin: "https://github.com/anomalyco/opencode.git",
    source_repo: "./opencode",
    work_repo: "./.orw/repo/opencode-build",
    runtime_dir: "./.orw",
    base_branch: "dev",
    branches: [],
    poll_minutes: 30,
    agent: "build",
    model: "openai/gpt-5.5-fast",
    opencode_bin: "opencode",
    desktop_target: defaultDesktopTarget(),
    install_cli: true,
    install_desktop: defaultInstallDesktop(),
    notify_timeout: 120,
  };
}

function defaultInstallDesktop() {
  return process.platform === "darwin";
}

function defaultDesktopTarget() {
  if (process.platform === "darwin") return "/Applications/OpenCode.app";
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "Programs", "OpenCode", "OpenCode.exe");
  }
  return path.join(os.homedir(), "Applications", "OpenCode.AppImage");
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function statePath(cfg: Cfg) {
  return path.join(cfg.runtime_dir, "state", "state.json");
}

function lockPath(cfg: Cfg) {
  return path.join(cfg.runtime_dir, "run", "watch.lock");
}

function logDir(cfg: Cfg) {
  return path.join(cfg.runtime_dir, "logs");
}

async function pull(cfg: Cfg, force: boolean) {
  const searchPaths = [
    cfg.config_dir,
    path.join(cfg.config_dir, "submodules", "arcus"),
    path.join(cfg.config_dir, "..", "arcus"),
    path.join(os.homedir(), ".config", "opencode", "arcus"),
    "/Volumes/Topper2TB/Git/arcus",
  ];

  const targetKey = resolveArcusTargetKey(process.platform, process.arch);
  const { blessed, manifest, manifestRelativePath } = await loadBlessedAndManifest(
    undefined,
    searchPaths,
  );
  const info = parseBlessedHostManifest(blessed, manifest, targetKey);

  const prev = await readState(cfg);
  if (!force && prev.tag === info.tag && prev.sha256 === info.asset.sha256) {
    return out(
      `Already up to date with blessed OpenCode ${info.tag} (fleet ${info.fleetVersion}). Use --force to reinstall.`,
    );
  }

  const free = await hold(cfg, force);
  try {
    out(`=== Arcus Binary Pull: OpenCode ${info.tag} (${targetKey}) ===`);
    out(`  Fleet Version: ${info.fleetVersion}`);
    out(`  Asset:         ${info.asset.filename}`);
    out(`  Release URL:   ${info.asset.url}`);
    out(`  Expected SHA:  ${info.asset.sha256}`);
    out("");

    const cacheDir = path.join(cfg.runtime_dir, "cache", `arcus-${info.version}-${Date.now()}`);
    const archivePath = path.join(cacheDir, info.asset.filename);
    const extractDir = path.join(cacheDir, "extracted");

    out(`-> Downloading verified binary asset...`);
    await downloadAndVerifyAsset(info.asset.url, info.asset.sha256, archivePath);
    out(`   ✓ Download verified against SHA256 checksum`);

    out(`-> Extracting binary payload...`);
    const binaryPath = await extractBinaryFromArchive(archivePath, info.binaryName, extractDir);
    out(`   ✓ Extracted ${info.binaryName}`);

    out(`-> Installing CLI binary...`);
    await installCli(binaryPath);

    const nextState: State = {
      tag: info.tag,
      branch: "arcus/host",
      release_url: info.asset.url,
      cli: path.join(os.homedir(), ".opencode", "bin", info.binaryName),
      source: "arcus",
      sha256: info.asset.sha256,
      manifest: manifestRelativePath,
      fleet_version: info.fleetVersion,
      at: new Date().toISOString(),
    };
    await writeState(cfg, nextState);

    await notify(
      "OpenCode Arcus binary installed",
      `${info.tag} (${info.fleetVersion}) installed to ~/.opencode/bin/${info.binaryName}`,
    );

    out("");
    out(`[OK] Successfully installed OpenCode ${info.tag} from Arcus.`);
    out(`  Target:  ${path.join(os.homedir(), ".opencode", "bin", info.binaryName)}`);
    out(`  Version: ${info.version}`);
    out(`  Fleet:   ${info.fleetVersion}`);
  } finally {
    await free();
  }
}

async function check(cfg: Cfg, force: boolean) {
  const release = await latest(cfg);
  const prev = await readState(cfg);
  if (!force && prev.tag === release.tag_name)
    return out(`No new release. Latest is ${release.tag_name}.`);

  const sources = resolveSources(cfg);
  const free = await hold(cfg, force);
  try {
    const log = path.join(
      logDir(cfg),
      `${stamp()}-${release.tag_name.replaceAll("/", "-")}.log`,
    );
    await fs.mkdir(path.dirname(log), { recursive: true });
    await note(
      log,
      `Watching ${cfg.release_repo}\nRelease ${release.tag_name}\n`,
    );
    await prep(cfg, sources, log);
    const env = releaseEnv(release);
    const prompt = await render(cfg, sources, release);
    try {
      await run(
        [
          cfg.opencode_bin,
          "run",
          "--agent",
          cfg.agent,
          "--model",
          cfg.model,
          prompt,
        ],
        {
          cwd: cfg.work_repo,
          log,
          env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
        },
      );
    } catch (err) {
      await notify(
        "OpenCode integration failed",
        `${release.tag_name} failed. See ${log}.`,
      );
      throw err;
    }

    const next = await verifyBuild(cfg, release, log);
    await writeState(cfg, next);
    await notify(
      "OpenCode build ready",
      `${release.tag_name} is integrated and built.`,
    );
    const running = await runningOpenCodeProcesses();
    if (running.length > 0) {
      await notify(
        "OpenCode install blocked",
        `Run ${orwCommand(cfg, "install-when-closed")}, then quit OpenCode to install.`,
      );
      out(`Integrated ${release.tag_name}. Install skipped because OpenCode is running:`);
      for (const proc of running) out(`- pid ${proc.pid}: ${proc.command}`);
      out("");
      out("To install after OpenCode exits, run:");
      out(`  ${orwCommand(cfg, "install-when-closed")}`);
      return;
    }
    if (canPromptForInstall()) {
      const ok = await ask(
        "OpenCode build ready",
        `${release.tag_name} is ready. Install the ${installLabel(cfg)} now?`,
        cfg.notify_timeout,
      );
      if (ok === "Yes") {
        await install(cfg, next);
        await notify(
          "OpenCode installed",
          `${release.tag_name} was installed from the local build.`,
        );
      } else {
        printInstallHint(cfg, release.tag_name);
      }
    } else {
      printInstallHint(cfg, release.tag_name);
    }
    out(`Integrated ${release.tag_name}`);
  } finally {
    await free();
  }
}

async function verifyBuild(
  cfg: Cfg,
  release: { tag_name: string; html_url: string },
  log: string,
): Promise<State> {
  const cli = cliPath(cfg);
  try {
    await fs.access(cli);
    const version = await textOut([cli, "--version"]);
    const expected = releaseVersion(release.tag_name);
    if (version !== expected) {
      throw new Error(`Built CLI reported version ${version}, expected ${expected}`);
    }
    const app = cfg.install_desktop ? await appPath(cfg) : undefined;
    if (app) await fs.access(app);
    return {
      tag: release.tag_name,
      branch: branch(release.tag_name),
      release_url: release.html_url,
      cli,
      app,
      log,
      at: new Date().toISOString(),
    };
  } catch (err) {
    await notify(
      "OpenCode integration failed",
      `${release.tag_name} did not produce verified artifacts. See ${log}.`,
    );
    throw err;
  }
}

async function latest(cfg: Cfg) {
  const url = `https://api.github.com/repos/${cfg.release_repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch latest release: ${res.status}`);
  const body = (await res.json()) as { tag_name: string; html_url: string };
  return body;
}

async function prep(cfg: Cfg, sources: IntegrationSource[], log: string) {
  await fs.rm(cfg.work_repo, { recursive: true, force: true });
  await fs.mkdir(path.dirname(cfg.work_repo), { recursive: true });
  await run(["git", "clone", cfg.git_origin, cfg.work_repo], { log });
  await run(["git", "fetch", "origin", cfg.base_branch, "--tags"], {
    cwd: cfg.work_repo,
    log,
  });
  for (const item of sources) {
    await run(
      ["git", "fetch", item.repo, `${item.fetchRef}:${item.fetch}`],
      {
        cwd: cfg.work_repo,
        log,
      },
    );
  }
  await run(["bun", "install"], {
    cwd: cfg.work_repo,
    log,
  });
}

async function render(
  cfg: Cfg,
  sources: IntegrationSource[],
  release: { tag_name: string; html_url: string },
) {
  const env = releaseEnv(release);
  const tpl = await fs.readFile(cfg.prompt_path, "utf8");
  const vars = {
    repo: cfg.work_repo,
    tag: release.tag_name,
    version: env.OPENCODE_VERSION,
    channel: env.OPENCODE_CHANNEL,
    branches: sources.map((item) => item.label).join(", "),
    branch: branch(release.tag_name),
    merges: sources.map((item) => item.merge).join(", then "),
    cli: cliPath(cfg),
    app: appPathPattern(cfg),
    desktop_requirement: cfg.install_desktop
      ? "Build and package the Electron desktop app for this host platform."
      : "Desktop packaging is disabled in ORW config; build and verify the host CLI only.",
    desktop_tasks: cfg.install_desktop
      ? [
          `7. Prepare the production Electron desktop package in \`packages/desktop\` with \`OPENCODE_CHANNEL=prod OPENCODE_VERSION=${env.OPENCODE_VERSION} bun ./scripts/prepare.ts\`.`,
          `8. Build the production Electron desktop assets in \`packages/desktop\` with \`OPENCODE_CHANNEL=prod OPENCODE_VERSION=${env.OPENCODE_VERSION} bun run build\`.`,
          `9. Package the production Electron desktop app in \`packages/desktop\` with \`OPENCODE_CHANNEL=prod OPENCODE_VERSION=${env.OPENCODE_VERSION} bun run ${desktopPackageScript()}\`.`,
          `10. Confirm a desktop artifact exists at \`${appPathPattern(cfg)}\`.`,
        ].join("\n")
      : "7. Skip Electron desktop packaging because `install_desktop` is false.",
    release_repo: cfg.release_repo,
    base: cfg.base_branch,
    release_url: release.html_url,
    sources: sources
      .map((item) => `${item.label} -> ${item.merge}`)
      .join("\n- "),
  };
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    tpl,
  );
}

function branch(tag: string) {
  return `integrate/${tag.replace(/^v/, "v")}`;
}

function releaseVersion(tag: string) {
  return tag.replace(/^v/, "");
}

function releaseEnv(release: { tag_name: string }) {
  return {
    OPENCODE_CHANNEL: "latest",
    OPENCODE_VERSION: releaseVersion(release.tag_name),
  };
}

function targetArch() {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  throw new Error(`Unsupported architecture: ${process.arch}`);
}

function cliTargetOs() {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  if (process.platform === "win32") return "windows";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function cliBinaryName() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function cliPath(cfg: Cfg) {
  const name = `opencode-${cliTargetOs()}-${targetArch()}`;
  return path.join(
    cfg.work_repo,
    "packages",
    "opencode",
    "dist",
    name,
    "bin",
    cliBinaryName(),
  );
}

async function appPath(cfg: Cfg) {
  const dist = path.join(cfg.work_repo, "packages", "desktop", "dist");
  const artifact = await findDesktopArtifact(dist);
  if (!artifact) throw new Error(`No desktop artifact found in ${dist}`);
  return artifact;
}

function appPathPattern(cfg: Cfg) {
  const dist = path.join(cfg.work_repo, "packages", "desktop", "dist");
  if (process.platform === "darwin") return path.join(dist, process.arch === "arm64" ? "mac-arm64" : "mac", "*.app");
  if (process.platform === "linux") return path.join(dist, "opencode-desktop-linux-*");
  if (process.platform === "win32") return path.join(dist, "opencode-desktop-win-*.exe");
  return path.join(dist, "<desktop artifact>");
}

function desktopPackageScript() {
  if (process.platform === "darwin") return "package:mac";
  if (process.platform === "linux") return "package:linux";
  if (process.platform === "win32") return "package:win";
  throw new Error(`Unsupported desktop packaging platform: ${process.platform}`);
}

async function findDesktopArtifact(dir: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (process.platform === "darwin" && entry.isDirectory() && entry.name.endsWith(".app")) return file;
    if (process.platform === "linux" && entry.isFile() && /\.(AppImage|deb|rpm)$/i.test(entry.name)) return file;
    if (process.platform === "win32" && entry.isFile() && /\.exe$/i.test(entry.name)) return file;
    if (entry.isDirectory()) {
      const nested = await findDesktopArtifact(file);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function installReady(cfg: Cfg, opts: { waitForOpenCode?: boolean } = {}) {
  const cur = await readState(cfg);
  if (!cur.tag) throw new Error("No ready build recorded yet");
  if (opts.waitForOpenCode) await waitForNoOpenCodeRunning(cur.tag);
  await install(cfg, cur);
  out(`Installed ${cur.tag}`);
}

async function installWhenClosed(cfg: Cfg) {
  const cur = await readState(cfg);
  if (!cur.tag) throw new Error("No ready build recorded yet");
  const log = path.join(logDir(cfg), `${stamp()}-${cur.tag.replaceAll("/", "-")}-install.log`);
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(
    log,
    `Waiting for OpenCode to exit before installing ${cur.tag}\n`,
    { flag: "a" },
  );

  const output = await fs.open(log, "a");
  try {
    const child = spawn(
      process.execPath,
      selfBunArgs(cfg, ["install-ready", "--wait-for-opencode"]),
      {
        cwd: cfg.config_dir,
        env: process.env,
        detached: true,
        stdio: ["ignore", output.fd, output.fd],
      },
    );
    child.unref();
  } finally {
    await output.close();
  }

  out(`Started deferred installer for ${cur.tag}.`);
  out(`Log: ${log}`);
  out("Quit OpenCode; the installer will wait, then install the ready CLI and any supported desktop artifact.");
}

async function preview(cfg: Cfg) {
  const sources = resolveSources(cfg);
  const release = await latest(cfg);
  out(`tag=${release.tag_name}`);
  out(`url=${release.html_url}`);
  out("");
  out(await render(cfg, sources, release));
}

function resolveSources(cfg: Cfg) {
  return cfg.branches.map((input) => parseSource(input, cfg.source_repo));
}

function parseSource(input: string, source: string): IntegrationSource {
  const value = input.trim();
  if (!value) throw new Error("Empty integration source in config branches");

  if (!value.startsWith("https://github.com/")) {
    return {
      label: value,
      repo: source,
      fetchRef: `refs/heads/${value}`,
      fetch: `refs/remotes/watch/local/${value}`,
      merge: `refs/remotes/watch/local/${value}`,
    };
  }

  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) throw new Error(`Unsupported GitHub source URL: ${value}`);

  if (parts.length >= 4 && parts[2] === "tree") {
    const branch = decodeURIComponent(parts.slice(3).join("/"));
    const ref = `refs/remotes/watch/${watchSlug(owner, repo)}/${branch}`;
    return {
      label: `${owner}/${repo}:${branch}`,
      repo: `https://github.com/${owner}/${repo}.git`,
      fetchRef: `refs/heads/${branch}`,
      fetch: ref,
      merge: ref,
    };
  }

  if (parts.length >= 4 && parts[2] === "pull") {
    const number = parts[3];
    if (!/^\d+$/.test(number)) {
      throw new Error(`Unsupported GitHub pull request URL: ${value}`);
    }
    const ref = `refs/remotes/watch/${watchSlug(owner, repo)}/pr-${number}`;
    return {
      label: `${owner}/${repo}#${number}`,
      repo: `https://github.com/${owner}/${repo}.git`,
      fetchRef: `refs/pull/${number}/head`,
      fetch: ref,
      merge: ref,
    };
  }

  throw new Error(`Unsupported GitHub integration source URL: ${value}`);
}

function watchSlug(owner: string, repo: string) {
  return `${owner}-${repo}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

function canPromptForInstall() {
  return process.platform === "darwin";
}

function installLabel(cfg: Cfg) {
  if (cfg.install_desktop && process.platform === "darwin") return "CLI and Electron desktop app";
  return "CLI";
}

function orwCommand(cfg: Cfg, command: string) {
  return `bunx ${packageName} --config ${shellArg(cfg.config_file)} ${command}`;
}

function printInstallHint(cfg: Cfg, tag: string) {
  out(`${tag} build is ready.`);
  if (cfg.install_cli) {
    out("To install the built CLI, run:");
    out(`  ${orwCommand(cfg, "install-ready")}`);
  }
  if (cfg.install_desktop && process.platform !== "darwin") {
    out("Desktop auto-install is only supported on macOS; the packaged desktop artifact is recorded in status after verification.");
  }
}

async function install(cfg: Cfg, cur: State) {
  await ensureNoOpenCodeRunning();
  const cli = cur.cli ?? cliPath(cfg);
  if (cfg.install_cli) await installCli(cli);
  if (cfg.install_desktop) {
    const app = cur.app ?? (await appPath(cfg));
    await installDesktopApp(app, cfg.desktop_target);
  }
}

async function installCli(source: string) {
  const target = path.join(os.homedir(), ".opencode", "bin", cliBinaryName());
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  if (process.platform !== "win32") await fs.chmod(target, 0o755);
  out(`Installed CLI to ${target}`);
}

async function installDesktopApp(source: string, target: string) {
  if (process.platform !== "darwin") {
    out(`Desktop artifact ready at ${source}`);
    out("Automatic desktop install is currently only supported on macOS; install this artifact manually.");
    return;
  }
  try {
    await installDesktopAppDirect(source, target);
    await run(["open", target]);
  } catch (err) {
    out(`Direct desktop install failed for ${target}; retrying with administrator privileges.`);
    await installDesktopAppPrivileged(source, target);
  }
}

async function installDesktopAppDirect(source: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true, force: true });
  await run(["xattr", "-dr", "com.apple.quarantine", target]).catch(() => 0);
  await run(["codesign", "--force", "--deep", "--sign", "-", target]);
  await run(["codesign", "--verify", "--deep", target]);
}

async function installDesktopAppPrivileged(source: string, target: string) {
  const script = [
    "set -e",
    `mkdir -p ${shell(path.dirname(target))}`,
    `rm -rf ${shell(target)}`,
    `cp -R ${shell(source)} ${shell(target)}`,
    `xattr -dr com.apple.quarantine ${shell(target)} 2>/dev/null || true`,
    `codesign --force --deep --sign - ${shell(target)}`,
    `codesign --verify --deep ${shell(target)}`,
  ].join("\n");
  await run(["osascript", "-e", `do shell script ${quote(script)} with administrator privileges`]);
}

function shell(input: string) {
  return `'${input.replaceAll("'", `'\''`)}'`;
}

function shellArg(input: string) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(input)) return input;
  return JSON.stringify(input);
}

async function ensureNoOpenCodeRunning() {
  const running = await runningOpenCodeProcesses();
  if (running.length === 0) return;
  const details = running
    .map((proc) => `pid ${proc.pid}: ${proc.command}`)
    .join("\n");
  throw new Error(
    `OpenCode is currently running. Quit all OpenCode windows/processes before installing.\n${details}`,
  );
}

async function waitForNoOpenCodeRunning(tag: string) {
  let printed = false;
  while (true) {
    const running = await runningOpenCodeProcesses();
    if (running.length === 0) return;
    if (!printed) {
      out(`Waiting for OpenCode to quit before installing ${tag}...`);
      printed = true;
    }
    for (const proc of running) out(`- pid ${proc.pid}: ${proc.command}`);
    await sleep(5_000);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runningOpenCodeProcesses(): Promise<OpenCodeProcess[]> {
  if (process.platform === "win32") return runningWindowsOpenCodeProcesses();
  const text = await textOut(["ps", "-axo", "pid=,command="]);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isInteger(pid) || pid === process.pid) return [];
      return isOpenCodeProcess(command) ? [{ pid, command }] : [];
    });
}

async function runningWindowsOpenCodeProcesses(): Promise<OpenCodeProcess[]> {
  const command = [
    "Get-CimInstance Win32_Process",
    "Where-Object { $_.Name -match '^(opencode|OpenCode)(\\.exe)?$' -or $_.CommandLine -match 'OpenCode' }",
    "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
  ].join(" | ");
  const text = await textOut(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]).catch(() => "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [pidText, ...commandParts] = line.split("\t");
      const pid = Number(pidText);
      const command = commandParts.join("\t");
      if (!Number.isInteger(pid) || pid === process.pid) return [];
      return command ? [{ pid, command }] : [];
    });
}

function isOpenCodeProcess(command: string) {
  const executable = command.split(/\s+/, 1)[0] ?? "";
  const name = path.basename(executable);
  if (name === "opencode" || name === "opencode.exe") return true;
  if (name === "OpenCode" || name === "OpenCode.exe" || name.startsWith("OpenCode ")) return true;
  return /\/OpenCode(?: [^/]+)?\.app\/Contents\//.test(command);
}

async function status(cfg: Cfg) {
  const cur = await readState(cfg);
  const text = [
    `config=${cfg.config_file}`,
    `source_repo=${cfg.source_repo}`,
    `work_repo=${cfg.work_repo}`,
    `runtime_dir=${cfg.runtime_dir}`,
    `platform=${process.platform}-${process.arch}`,
    `install_desktop=${cfg.install_desktop}`,
    `last_tag=${cur.tag ?? "<none>"}`,
    `last_branch=${cur.branch ?? "<none>"}`,
    `last_log=${cur.log ?? "<none>"}`,
    `desktop_target=${cfg.desktop_target}`,
  ].join("\n");
  out(text);
}

async function installLaunchd(cfg: Cfg) {
  if (process.platform !== "darwin") {
    throw new Error("launchd integration is only available on macOS");
  }
  const bun = process.execPath;
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("getuid is not available on this platform");
  const target = `gui/${uid}`;
  await fs.mkdir(path.dirname(launch), { recursive: true });
  await fs.mkdir(logDir(cfg), { recursive: true });
  const programArgs = [bun, "x", packageSpec(), "check", "--config", cfg.config_file];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((item) => `    <string>${xml(item)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(cfg.config_dir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${cfg.poll_minutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir(cfg), "launchd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir(cfg), "launchd.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(process.env.PATH ?? "")}</string>
  </dict>
</dict>
</plist>
`;
  await fs.writeFile(launch, plist);
  await run(["launchctl", "bootout", target, launch]).catch(() => 0);
  await run(["launchctl", "bootstrap", target, launch]);
  await run(["launchctl", "enable", `${target}/${label}`]).catch(() => 0);
  out(`Installed launchd job at ${launch}`);
}

async function uninstallLaunchd() {
  if (process.platform !== "darwin") {
    out("launchd integration is only available on macOS");
    return;
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    await run(["launchctl", "bootout", `gui/${uid}`, launch]).catch(() => 0);
  }
  await fs.rm(launch, { force: true });
  out(`Removed ${launch}`);
}

function xml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function notify(title: string, text: string) {
  if (process.platform !== "darwin") {
    out(`${title}: ${text}`);
    return;
  }
  await run([
    "osascript",
    "-e",
    `display notification ${quote(text)} with title ${quote(title)}`,
  ]);
}

async function ask(title: string, text: string, timeout: number) {
  if (process.platform !== "darwin") {
    out(`${title}: ${text}`);
    return "No";
  }
  const output = await textOut([
    "osascript",
    "-e",
    `display dialog ${quote(text)} buttons {"No", "Yes"} default button "Yes" with title ${quote(title)} giving up after ${timeout}`,
  ]);
  if (output.includes("gave up:true")) return "No";
  return output.includes("Yes") ? "Yes" : "No";
}

function quote(text: string) {
  return JSON.stringify(text);
}

function packageSpec() {
  return process.env.ORW_PACKAGE_SPEC || packageName;
}

function selfBunArgs(cfg: Cfg, args: string[]) {
  return ["x", packageSpec(), ...args, "--config", cfg.config_file];
}

function norm(input: string) {
  return input.replace(/^[\u2012\u2013\u2014\u2015\u2212]+/, (dash) =>
    "-".repeat(dash.length),
  );
}

async function hold(cfg: Cfg, force = false) {
  const lock = lockPath(cfg);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    await fs.writeFile(lock, String(process.pid), {
      flag: "wx",
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code !== "EEXIST") throw err;
    const pid = await readLock(lock);
    if (pid && alive(pid)) {
      throw new Error(`watcher is already running with pid ${pid}`);
    }
    await fs.rm(lock, { force: true });
    await fs.writeFile(lock, String(process.pid), {
      flag: "wx",
    });
    out(
      force
        ? `Recovered stale lock ${pid ?? "<unknown>"} with --force.`
        : `Recovered stale lock ${pid ?? "<unknown>"}.`,
    );
  }
  return async () => {
    await fs.rm(lock, { force: true });
  };
}

async function readLock(lock: string) {
  try {
    const text = (await fs.readFile(lock, "utf8")).trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (!(err instanceof Error)) return true;
    return !String(err).includes("ESRCH");
  }
}

async function readState(cfg: Cfg): Promise<State> {
  const state = statePath(cfg);
  try {
    return JSON.parse(await fs.readFile(state, "utf8")) as State;
  } catch {
    return {};
  }
}

async function writeState(cfg: Cfg, input: State) {
  const state = statePath(cfg);
  await fs.mkdir(path.dirname(state), { recursive: true });
  await fs.writeFile(state, JSON.stringify(input, null, 2) + "\n");
}

async function note(file: string, text: string) {
  await fs.writeFile(file, text, { flag: "a" });
}

async function run(cmd: string[], input?: ExecInput) {
  const code = await exec(cmd, input);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
  return code;
}

async function textOut(cmd: string[], input?: ExecInput) {
  let data = "";
  await exec(cmd, { ...input, printStdout: false }, (chunk) => {
    data += chunk;
  });
  return data.trim();
}

async function exec(cmd: string[], input?: ExecInput, onStdout?: (chunk: string) => void) {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: input?.cwd,
      env: { ...process.env, ...input?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const write = async (line: string) => {
      if (!input?.log) return;
      await fs.writeFile(input.log, line, { flag: "a" });
    };
    child.stdout.on("data", (buf: Buffer) => {
      const chunk = String(buf);
      if (input?.printStdout !== false) process.stdout.write(chunk);
      onStdout?.(chunk);
      void write(chunk);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const chunk = String(buf);
      if (input?.printStderr !== false) process.stderr.write(chunk);
      void write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });
}

function stamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function out(text: string) {
  process.stdout.write(`${text}\n`);
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
