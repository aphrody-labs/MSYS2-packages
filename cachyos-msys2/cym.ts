import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Source = { name: string; path: string; kind?: "external"; origin: string; upstream: string };
type Builder = { name: string; path: string; command: string[] };
type Manifest = {
  schema: number;
  dashboard: string;
  mirrors: string;
  optimizedRepositories: { documentation: string; architectures: string[]; policy: string };
  gaming: { documentation: string; proton: string; wine: string; ntsync: boolean; components: string[] };
  kernel: { documentation: string; default: string; compiler: string; profile: string; tickRateHz: number; schedulers: string[]; variants: string[]; modules: string[] };
  omarchy: { repository: string; packages: string; channels: string[]; architectures: string[]; recipeRoot: string };
  pipeline: { layers: string[]; emulators: string[]; builders: Builder[] };
  sources: Source[];
};

const args = process.argv.slice(2);
let rootOverride: string | undefined;
let manifestOverride: string | undefined;
const rootIndex = args.indexOf("--root");
if (rootIndex >= 0) {
  rootOverride = args[rootIndex + 1];
  args.splice(rootIndex, 2);
}
const manifestIndex = args.indexOf("--manifest");
if (manifestIndex >= 0) {
  manifestOverride = args[manifestIndex + 1];
  args.splice(manifestIndex, 2);
}
const json = args.includes("--json");
const positionals = args.filter(arg => !arg.startsWith("--"));
const command = positionals[0] ?? "doctor";
const action = positionals[1] ?? "validate";

function msysRoot(): string {
  if (rootOverride) return resolve(rootOverride);
  if (process.env.MSYS2_ROOT) return resolve(process.env.MSYS2_ROOT);
  const exeRoot = resolve(dirname(process.execPath), "..", "..");
  if (existsSync(join(exeRoot, "etc", "pacman.conf"))) return exeRoot;
  let cursor = resolve(process.cwd());
  while (dirname(cursor) !== cursor) {
    if (existsSync(join(cursor, "etc", "pacman.conf"))) return cursor;
    cursor = dirname(cursor);
  }
  throw new Error("MSYS2 introuvable; utilisez --root ou MSYS2_ROOT");
}

function engineRoot(root: string): string {
  if (process.env.BUN_ENGINE_ROOT) return resolve(process.env.BUN_ENGINE_ROOT);
  const home = join(root, "home");
  if (existsSync(home)) {
    for (const user of readdirSync(home)) {
      const candidate = join(home, user, "projects", "bun-engine");
      if (existsSync(join(candidate, ".gitmodules"))) return candidate;
    }
  }
  throw new Error("bun-engine introuvable; utilisez BUN_ENGINE_ROOT");
}

function manifest(root: string): Manifest {
  if (manifestOverride) return JSON.parse(readFileSync(resolve(manifestOverride), "utf8"));
  const installed = join(root, "usr", "share", "cachyos-msys2", "sources.json");
  const source = join(root, "usr", "src", "msys2-packages", "cachyos-msys2", "sources.json");
  return JSON.parse(readFileSync(existsSync(installed) ? installed : source, "utf8"));
}

function run(argv: string[], cwd?: string): void {
  const result = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} a échoué (${result.exitCode})`);
}

function git(root: string, repo: string, argv: string[]): void {
  const gitExe = Bun.which("git.exe") ?? Bun.which("git") ?? join(root, "usr", "bin", "git.exe");
  run([gitExe, "-C", repo, ...argv]);
}

function linkSources(root: string, data: Manifest): void {
  const engine = engineRoot(root);
  const targetRoot = join(root, "usr", "src", "cachyos");
  mkdirSync(targetRoot, { recursive: true });
  for (const source of data.sources) {
    if (source.kind === "external") continue;
    const target = join(engine, ...source.path.split("/"));
    const link = join(targetRoot, source.name);
    if (!existsSync(target)) throw new Error(`source absente: ${target}`);
    if (existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink()) throw new Error(`conflit non-lien: ${link}`);
      continue;
    }
    symlinkSync(target, link, "junction");
  }
}

function syncSources(root: string, data: Manifest): void {
  const base = join(root, "usr", "src", "cachyos");
  linkSources(root, data);
  for (const source of data.sources) {
    const repo = join(base, source.name);
    if (!existsSync(repo)) {
      if (source.kind !== "external") throw new Error(`source liée absente: ${repo}`);
      const gitExe = Bun.which("git.exe") ?? Bun.which("git") ?? join(root, "usr", "bin", "git.exe");
      run([gitExe, "clone", "--filter=blob:none", source.origin, repo]);
    }
    git(root, repo, ["remote", "set-url", "origin", source.origin]);
    const gitExe = Bun.which("git.exe") ?? Bun.which("git") ?? join(root, "usr", "bin", "git.exe");
    const remotes = Bun.spawnSync([gitExe, "-C", repo, "remote"], { stdout: "pipe" });
    const names = remotes.stdout.toString().split(/\s+/);
    if (names.includes("upstream")) git(root, repo, ["remote", "set-url", "upstream", source.upstream]);
    else git(root, repo, ["remote", "add", "upstream", source.upstream]);
    git(root, repo, ["fetch", "--prune", "origin"]);
    git(root, repo, ["fetch", "--prune", "upstream"]);
  }
}

function configurePacman(root: string): void {
  const conf = join(root, "etc", "pacman.conf");
  const text = readFileSync(conf, "utf8");
  if (text.includes("[cachyos-msys2]")) return;
  throw new Error("dépôt absent de pacman.conf; installez le paquet construit avec pacman -U puis relancez cym publish");
}

function buildPackage(root: string): void {
  const bash = join(root, "usr", "bin", "bash.exe");
  run([bash, "-lc", "cd /usr/src/msys2-packages/cachyos-msys2 && makepkg --cleanbuild --clean --force"]);
}

function publish(root: string): void {
  buildPackage(root);
  const dir = join(root, "usr", "src", "msys2-packages", "cachyos-msys2");
  const packages = readdirSync(dir).filter(name => name.endsWith(".pkg.tar.zst")).map(name => join(dir, name));
  if (packages.length === 0) throw new Error("aucun paquet produit");
  const repo = join(root, "var", "cache", "cachyos-msys2");
  mkdirSync(repo, { recursive: true });
  for (const pkg of packages) copyFileSync(pkg, join(repo, pkg.split(/[\\/]/).at(-1)!));
  const packageArgs = packages.map(pkg => `/var/cache/cachyos-msys2/${pkg.split(/[\\/]/).at(-1)!}`).join(" ");
  run([join(root, "usr", "bin", "bash.exe"), "-lc", `repo-add /var/cache/cachyos-msys2/cachyos-msys2.db.tar.zst ${packageArgs}`]);
  configurePacman(root);
}

function doctor(root: string, data: Manifest): void {
  const engine = (() => { try { return engineRoot(root); } catch { return null; } })();
  const status = {
    root,
    pacman: existsSync(join(root, "usr", "bin", "pacman.exe")),
    makepkg: existsSync(join(root, "usr", "bin", "makepkg")),
    repoAdd: existsSync(join(root, "usr", "bin", "repo-add")),
    dashboard: data.dashboard,
    engine,
    sources: data.sources.map(source => {
      const linked = existsSync(join(root, "usr", "src", "cachyos", source.name));
      const available = source.kind === "external" ? linked : !!engine && existsSync(join(engine, ...source.path.split("/")));
      return { name: source.name, linked, available };
    }),
  };
  if (json) console.log(JSON.stringify(status, null, 2));
  else console.log(status);
  if (!status.pacman || !status.makepkg || !status.repoAdd || !engine || status.sources.some(source => !source.available)) process.exitCode = 1;
}

function pipelineStatus(root: string, data: Manifest) {
  const engine = engineRoot(root);
  const sourceRoot = join(root, "usr", "src", "cachyos");
  const emulatorRoot = join(engine, "plugins", "emulation", "rust");
  const sourceState = data.sources.map(source => ({ name: source.name, ready: existsSync(join(sourceRoot, source.name)) }));
  const emulators = data.pipeline.emulators.map(name => ({ name, ready: existsSync(join(emulatorRoot, name, "Cargo.toml")) }));
  const builders = data.pipeline.builders.map(builder => {
    const base = builder.name === "bun-engine" || builder.name === "cargo-workspace" ? engine : root;
    return { ...builder, ready: existsSync(join(base, ...builder.path.split("/"))) };
  });
  const omarchyRecipes = join(sourceRoot, "omarchy-pkgs", data.omarchy.recipeRoot);
  return {
    layers: data.pipeline.layers,
    sourceState,
    emulators,
    builders,
    omarchyRecipes: existsSync(omarchyRecipes) ? readdirSync(omarchyRecipes, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0,
  };
}

function pipeline(root: string, data: Manifest, mode: string): void {
  linkSources(root, data);
  const status = pipelineStatus(root, data);
  if (mode === "plan") {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const missing = [
    ...status.sourceState.filter(item => !item.ready).map(item => `source:${item.name}`),
    ...status.emulators.filter(item => !item.ready).map(item => `emulator:${item.name}`),
    ...status.builders.filter(item => !item.ready).map(item => `builder:${item.name}`),
  ];
  if (missing.length > 0) throw new Error(`pipeline incomplète: ${missing.join(", ")}`);
  if (status.omarchyRecipes === 0) throw new Error("aucune recette Omarchy détectée");
  if (mode === "build") {
    const engine = engineRoot(root);
    const bunExe = Bun.which("bun.exe") ?? Bun.which("bun");
    if (!bunExe) throw new Error("Bun introuvable");
    run([bunExe, "run", "./src/cli.ts", "build"], engine);
    buildPackage(root);
  } else if (mode !== "validate") {
    throw new Error(`action pipeline inconnue: ${mode}`);
  }
  console.log(JSON.stringify({ status: "ready", action: mode, ...status }, null, 2));
}

async function dashboard(data: Manifest): Promise<void> {
  const response = await fetch(data.mirrors, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`dashboard CachyOS: HTTP ${response.status}`);
  const html = await response.text();
  const count = (value: string) => html.match(new RegExp(`>${value}<`, "g"))?.length ?? 0;
  console.log(JSON.stringify({ url: data.dashboard, mirrors: data.mirrors, healthy: count("HEALTHY"), partial: count("PARTIAL"), error: count("ERROR") }, null, 2));
}

async function main(): Promise<void> {
  const root = msysRoot();
  const data = manifest(root);
  switch (command) {
    case "doctor": doctor(root, data); break;
    case "link": linkSources(root, data); doctor(root, data); break;
    case "sync": syncSources(root, data); break;
    case "build": buildPackage(root); break;
    case "publish": publish(root); break;
    case "dashboard": await dashboard(data); break;
    case "repos": console.log(JSON.stringify(data.optimizedRepositories, null, 2)); break;
    case "gaming": console.log(JSON.stringify(data.gaming, null, 2)); break;
    case "kernel": console.log(JSON.stringify(data.kernel, null, 2)); break;
    case "omarchy": console.log(JSON.stringify(data.omarchy, null, 2)); break;
    case "pipeline": pipeline(root, data, action); break;
    default: throw new Error(`commande inconnue: ${command}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
