# CachyOS MSYS2 unified pipeline

`cym` joins the Omarchy distribution and package recipes, the pinned CachyOS
kernel/gaming stack, native MSYS2 pacman packaging, Bun Engine emulators and
the Bun/Cargo/package builders.

```text
omarchy + omarchy-pkgs
          |
          v
cachyos kernel + proton + wine + drivers
          |
          v
msys2 makepkg + local pacman repository
          |
          v
bun-engine emulators + Bun/Cargo builders
```

- `cym pipeline plan` prints the resolved graph.
- `cym pipeline validate` checks every checkout, emulator and builder.
- `cym pipeline build` builds Bun Engine and then the MSYS2 package.
- `cym sync` fetches every writable fork and external source without changing
  branches or worktrees.

Linux packages remain source/build inputs on Windows. Only packages built for
the MSYS2 runtime are published to the local `[cachyos-msys2]` repository.
