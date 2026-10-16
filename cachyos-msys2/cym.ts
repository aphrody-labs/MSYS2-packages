import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type Source = { name: string; sourceId?: string; path: string; kind?: "external"; origin: string; upstream: string };
type Builder = { name: string; base?: "workspace" | "sources" | "engine"; path: string; command: string[] };
type Manifest = {
  schema: number;
  dashboard: string;
  mirrors: string;
  optimizedRepositories: Record<string, unknown>;
  gaming: Record<string, unknown>;
  kernel: Record<string, unknown>;
  omarchy: { recipeRoot: string; [key: string]: unknown };
  pipeline: { layers: string[]; emulators: string[]; emulatorRoot: string; builders: Builder[] };
  sources: Source[];
};
export interface CymContext {
  installationRoot: string;
  sourceRoot: string;
  workspace: string;
  engineRoot?: string;
  manifestPath: string;
}
interface DesktopOptions {
  root: string;
  sourceRoot: string;
  installationRoot: string;
}
interface WorkspaceOwner {
  runProcess(
    argv: string[],
    cwd: string,
    options: { timeoutMs: number; maxOutputBytes: number; stdout?: "inherit"; stderr?: "inherit"; stdin?: "inherit" },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}
interface DesktopOwner {
  planMsys2Desktop(options: DesktopOptions): Promise<Record<string, unknown>>;
  doctorMsys2Desktop(options: DesktopOptions): Promise<Record<string, unknown>>;
}
const help = `cym — native MSYS2 source/package integration for Bun OS
  doctor | link | sync | build | publish | dashboard | repos | gaming | kernel | omarchy
  pipeline plan|validate|build
  --root INSTALLED_MSYS2 --source-root VENDOR --workspace BUN_OS_ROOT
  [--engine-root EXTERNAL_ENGINE] [--manifest FILE] [--json]
Environment: APHRODY_MSYS2_ROOT, APHRODY_MSYS2_SOURCE_ROOT,
             APHRODY_WORKSPACE_ROOT, BUN_ENGINE_ROOT
doctor, link and pipeline plan/validate are read-only. link validates the flat
registry; no duplicate checkout/junction is created. sync fetches existing
registered repositories only. Build/publish require explicit commands.
`;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function contained(root: string, path: string) {
  const local = relative(root, path);
  return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}
function selected(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`Configure ${label} explicitly.`);
  return resolve(value);
}
export function resolveCymContext(options: {
  root?: string;
  sourceRoot?: string;
  workspace?: string;
  engineRoot?: string;
  manifest?: string;
}): CymContext {
  const workspace = selected(options.workspace ?? Bun.env.APHRODY_WORKSPACE_ROOT, "--workspace/APHRODY_WORKSPACE_ROOT");
  const pacman = Bun.which("pacman.exe") ?? Bun.which("pacman");
  const executableRoot = resolve(dirname(process.execPath), "../..");
  const installedRoot = existsSync(join(executableRoot, "etc/pacman.conf")) ? executableRoot : undefined;
  const installationRoot = selected(
    options.root ??
      Bun.env.APHRODY_MSYS2_ROOT ??
      Bun.env.MSYS2_ROOT ??
      (pacman ? resolve(dirname(pacman), "../..") : installedRoot),
    "--root/APHRODY_MSYS2_ROOT",
  );
  const sourceRoot = resolve(workspace, options.sourceRoot ?? Bun.env.APHRODY_MSYS2_SOURCE_ROOT ?? "vendor");
  const engine = options.engineRoot ?? Bun.env.BUN_ENGINE_ROOT;
  return {
    workspace,
    installationRoot,
    sourceRoot,
    ...(engine ? { engineRoot: resolve(engine) } : {}),
    manifestPath: resolve(options.manifest ?? join(sourceRoot, "msys2-packages/cachyos-msys2/sources.json")),
  };
}
export async function loadCymManifest(context: CymContext): Promise<Manifest> {
  const value: unknown = await Bun.file(context.manifestPath).json();
  if (
    !object(value) ||
    value.schema !== 2 ||
    !Array.isArray(value.sources) ||
    !object(value.pipeline) ||
    !Array.isArray(value.pipeline.builders) ||
    !Array.isArray(value.pipeline.emulators) ||
    typeof value.pipeline.emulatorRoot !== "string" ||
    !Array.isArray(value.pipeline.layers) ||
    !object(value.omarchy) ||
    typeof value.omarchy.recipeRoot !== "string" ||
    typeof value.dashboard !== "string" ||
    typeof value.mirrors !== "string" ||
    !object(value.optimizedRepositories) ||
    !object(value.gaming) ||
    !object(value.kernel)
  )
    throw new Error("Unsupported cym manifest schema.");
  if (
    value.sources.some(
      source =>
        !object(source) ||
        typeof source.name !== "string" ||
        typeof source.path !== "string" ||
        typeof source.origin !== "string" ||
        typeof source.upstream !== "string" ||
        (source.sourceId !== undefined && typeof source.sourceId !== "string"),
    ) ||
    value.pipeline.builders.some(
      builder =>
        !object(builder) ||
        typeof builder.name !== "string" ||
        typeof builder.path !== "string" ||
        !Array.isArray(builder.command) ||
        builder.command.some(arg => typeof arg !== "string") ||
        !["workspace", "sources", "engine"].includes(String(builder.base)),
    ) ||
    value.pipeline.emulators.some(name => typeof name !== "string") ||
    value.pipeline.layers.some(name => typeof name !== "string")
  )
    throw new Error("Invalid cym source/builder contract.");
  return value as Manifest;
}
async function owners(context: CymContext) {
  const processPath = join(context.workspace, "packages/bun-workspace/src/process.ts");
  const desktopPath = join(context.workspace, "factory/msys2/index.ts");
  if (!existsSync(processPath) || !existsSync(desktopPath))
    throw new Error("Selected workspace lacks the canonical Bun OS process/Desktop owners.");
  const processes: WorkspaceOwner = await import(pathToFileURL(processPath).href);
  const desktop: DesktopOwner = await import(pathToFileURL(desktopPath).href);
  if (
    typeof processes.runProcess !== "function" ||
    typeof desktop.planMsys2Desktop !== "function" ||
    typeof desktop.doctorMsys2Desktop !== "function"
  )
    throw new Error("Selected workspace owner API is incompatible.");
  return { processes, desktop };
}
async function run(context: CymContext, argv: string[], cwd: string, timeoutMs = 120_000, capture = false) {
  const { processes } = await owners(context);
  const result = await processes.runProcess(argv, cwd, {
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(capture ? {} : { stdout: "inherit", stderr: "inherit", stdin: "inherit" }),
  });
  if (result.code !== 0) throw new Error(`${basename(argv[0]!)} failed (${result.code}).`);
  return result;
}
function gitExecutable(context: CymContext) {
  return Bun.which("git.exe") ?? Bun.which("git") ?? join(context.installationRoot, "usr/bin/git.exe");
}
export async function cymSourceState(context: CymContext, data: Manifest) {
  const registry: unknown = await Bun.file(join(context.sourceRoot, "sources.json")).json();
  if (!object(registry) || !object(registry.sources)) throw new Error("Missing canonical vendor source registry.");
  const registered = registry.sources;
  return data.sources.map(source => {
    const entry = registered[source.sourceId ?? source.name];
    const declared = object(entry) && typeof entry.path === "string" ? entry.path : null;
    const path = declared ? resolve(context.sourceRoot, declared) : null;
    if (path && !contained(context.sourceRoot, path))
      throw new Error(`Source must resolve under vendor: ${source.name}`);
    return {
      name: source.name,
      sourceId: source.sourceId ?? source.name,
      path,
      available: Boolean(path && existsSync(join(path, ".git"))),
      declaredPathMatches: Boolean(declared && resolve(context.sourceRoot, source.path) === path),
    };
  });
}
async function syncSources(context: CymContext, data: Manifest) {
  const sources = await cymSourceState(context, data);
  for (const source of sources) {
    if (!source.available || !source.path || !source.declaredPathMatches)
      throw new Error(`Source is missing or differs from its registered owner: ${source.name}`);
    const remotes = await run(
      context,
      [gitExecutable(context), "-c", "core.fsmonitor=false", "-C", source.path, "remote"],
      context.workspace,
      15_000,
      true,
    );
    const names = remotes.stdout.trim().split(/\s+/);
    for (const name of ["origin", "upstream"])
      if (names.includes(name))
        await run(
          context,
          [gitExecutable(context), "-c", "core.fsmonitor=false", "-C", source.path, "fetch", "--prune", name],
          context.workspace,
          120_000,
        );
  }
}
async function buildPackage(context: CymContext) {
  const packageRoot = join(context.sourceRoot, "msys2-packages/cachyos-msys2");
  if (!existsSync(join(packageRoot, "PKGBUILD"))) throw new Error("Canonical cym PKGBUILD is missing.");
  const path = await run(
    context,
    [join(context.installationRoot, "usr/bin/cygpath.exe"), "-u", packageRoot],
    context.workspace,
    15_000,
    true,
  );
  await run(
    context,
    [
      join(context.installationRoot, "usr/bin/bash.exe"),
      "--noprofile",
      "--norc",
      "-c",
      'cd -- "$1" && exec makepkg --cleanbuild --clean --force',
      "cym",
      path.stdout.trim(),
    ],
    packageRoot,
    180_000,
  );
}
async function publish(context: CymContext) {
  await buildPackage(context);
  const packageRoot = join(context.sourceRoot, "msys2-packages/cachyos-msys2");
  const packages = readdirSync(packageRoot).filter(name => name.endsWith(".pkg.tar.zst"));
  if (!packages.length) throw new Error("No package was produced.");
  const repo = join(context.installationRoot, "var/cache/cachyos-msys2");
  mkdirSync(repo, { recursive: true });
  for (const name of packages) await Bun.write(join(repo, name), Bun.file(join(packageRoot, name)));
  const paths = await Promise.all(
    packages.map(name =>
      run(
        context,
        [join(context.installationRoot, "usr/bin/cygpath.exe"), "-u", join(repo, name)],
        context.workspace,
        15_000,
        true,
      ),
    ),
  );
  const db = await run(
    context,
    [join(context.installationRoot, "usr/bin/cygpath.exe"), "-u", join(repo, "cachyos-msys2.db.tar.zst")],
    context.workspace,
    15_000,
    true,
  );
  await run(
    context,
    [
      join(context.installationRoot, "usr/bin/bash.exe"),
      "--noprofile",
      "--norc",
      "-c",
      'exec repo-add "$@"',
      "cym",
      db.stdout.trim(),
      ...paths.map(path => path.stdout.trim()),
    ],
    repo,
  );
  if (!(await Bun.file(join(context.installationRoot, "etc/pacman.conf")).text()).includes("[cachyos-msys2]"))
    throw new Error("Local repository is not enabled in the selected installation's pacman.conf.");
}
async function pipelineStatus(context: CymContext, data: Manifest) {
  const sourceState = await cymSourceState(context, data);
  const registry: unknown = await Bun.file(join(context.sourceRoot, "sources.json")).json();
  const registered = object(registry) && object(registry.sources) ? registry.sources : {};
  const emulators = data.pipeline.emulators.map(name => {
    const entry = registered[name];
    const path = object(entry) && typeof entry.path === "string" ? resolve(context.sourceRoot, entry.path) : null;
    const externalEnginePath = context.engineRoot
      ? resolve(context.engineRoot, data.pipeline.emulatorRoot, name)
      : null;
    const registeredReady = Boolean(
      path && contained(context.sourceRoot, path) && existsSync(join(path, "Cargo.toml")),
    );
    const engineReady = Boolean(
      context.engineRoot &&
      externalEnginePath &&
      contained(context.engineRoot, externalEnginePath) &&
      existsSync(join(externalEnginePath, "Cargo.toml")),
    );
    return {
      name,
      path: registeredReady ? path : engineReady ? externalEnginePath : path,
      ready: registeredReady || engineReady,
      owner: registeredReady ? "vendor-registry" : engineReady ? "explicit-engine-workspace" : null,
      externalEnginePath,
    };
  });
  const builders = data.pipeline.builders.map(builder => {
    const base =
      builder.base === "engine"
        ? context.engineRoot
        : builder.base === "sources"
          ? context.sourceRoot
          : context.workspace;
    return { ...builder, ready: Boolean(base && existsSync(resolve(base, builder.path))) };
  });
  const recipes = join(context.sourceRoot, "omarchy-pkgs", data.omarchy.recipeRoot);
  const { desktop } = await owners(context);
  const desktopPlan = await desktop.planMsys2Desktop({
    root: context.workspace,
    sourceRoot: context.sourceRoot,
    installationRoot: context.installationRoot,
  });
  return {
    layers: data.pipeline.layers,
    sourceState,
    emulators,
    builders,
    omarchyRecipes: existsSync(recipes)
      ? readdirSync(recipes, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
      : 0,
    desktop: desktopPlan,
    mutation: false,
    buildQualified: false,
  };
}
async function pipeline(context: CymContext, data: Manifest, mode: string) {
  if (!["plan", "validate", "build"].includes(mode)) throw new Error(`Unknown pipeline action: ${mode}`);
  const status = await pipelineStatus(context, data);
  if (mode === "plan") return status;
  const missing = [
    ...status.sourceState
      .filter(source => !source.available || !source.declaredPathMatches)
      .map(source => `source:${source.name}`),
    ...status.emulators.filter(emulator => !emulator.ready).map(emulator => `emulator:${emulator.name}`),
    ...status.builders
      .filter(builder => !builder.ready && builder.base !== "engine")
      .map(builder => `builder:${builder.name}`),
  ];
  if (missing.length) throw new Error(`Incomplete source pipeline: ${missing.join(", ")}`);
  if (!status.omarchyRecipes) throw new Error("No registered Omarchy recipes found.");
  if (mode === "build") {
    const engineBuilder = data.pipeline.builders.find(
      builder => builder.name === "bun-engine" && builder.base === "engine",
    );
    if (!context.engineRoot || !engineBuilder)
      throw new Error("The external engine build needs --engine-root; no substitute builder is selected.");
    const enginePackage: unknown = await Bun.file(join(context.engineRoot, "package.json")).json();
    if (!object(enginePackage) || !object(enginePackage.scripts) || typeof enginePackage.scripts.build !== "string")
      throw new Error("The selected engine owner has no build script.");
    const bun = Bun.which("bun.exe") ?? Bun.which("bun");
    if (!bun) throw new Error("Expose the selected native Bun executable on PATH.");
    await run(context, [bun, ...engineBuilder.command.slice(1)], context.engineRoot, 180_000);
    await buildPackage(context);
  }
  return { ...status, action: mode, mutation: mode === "build" };
}
async function dashboard(data: Manifest) {
  const response = await fetch(data.mirrors, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`CachyOS dashboard: HTTP ${response.status}`);
  const html = await response.text();
  const count = (value: string) => html.match(new RegExp(`>${value}<`, "g"))?.length ?? 0;
  return {
    url: data.dashboard,
    mirrors: data.mirrors,
    healthy: count("HEALTHY"),
    partial: count("PARTIAL"),
    error: count("ERROR"),
  };
}
export async function runCym(argv = Bun.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      root: { type: "string" },
      "source-root": { type: "string" },
      workspace: { type: "string" },
      "engine-root": { type: "string" },
      manifest: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (positionals.length > 2 || (positionals.length > 1 && positionals[0] !== "pipeline"))
    throw new Error("Unexpected command arguments.");
  const context = resolveCymContext({
    root: values.root,
    sourceRoot: values["source-root"],
    workspace: values.workspace,
    engineRoot: values["engine-root"],
    manifest: values.manifest,
  });
  const data = await loadCymManifest(context);
  const command = positionals[0] ?? "doctor";
  let result: unknown;
  switch (command) {
    case "doctor": {
      const { desktop } = await owners(context);
      const doctor = await desktop.doctorMsys2Desktop({
        root: context.workspace,
        sourceRoot: context.sourceRoot,
        installationRoot: context.installationRoot,
      });
      result = doctor;
      if (doctor.metadataReady !== true) process.exitCode = 1;
      break;
    }
    case "link": {
      const sources = await cymSourceState(context, data);
      result = { sources, linksCreated: 0, mutation: false };
      if (sources.some(source => !source.available || !source.declaredPathMatches)) process.exitCode = 1;
      break;
    }
    case "sync":
      await syncSources(context, data);
      result = { fetched: true, clonesCreated: 0 };
      break;
    case "build":
      await buildPackage(context);
      result = { packageBuilt: true };
      break;
    case "publish":
      await publish(context);
      result = { published: true };
      break;
    case "dashboard":
      result = await dashboard(data);
      break;
    case "repos":
      result = data.optimizedRepositories;
      break;
    case "gaming":
      result = data.gaming;
      break;
    case "kernel":
      result = data.kernel;
      break;
    case "omarchy":
      result = data.omarchy;
      break;
    case "pipeline":
      result = await pipeline(context, data, positionals[1] ?? "validate");
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main)
  runCym().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
