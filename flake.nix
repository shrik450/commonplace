{
  description = "Commonplace: a personal reading archive";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.chromium
            # single-file-cli runs under `#!/usr/bin/env node`.
            pkgs.nodejs
            pkgs.just
            pkgs.podman
          ];
          # The browser tests and screenshot tool drive this Chromium through
          # playwright-core, which never downloads a browser of its own.
          COMMONPLACE_TEST_BROWSER = "${pkgs.chromium}/bin/chromium";
        };
      });

      formatter = forEachSystem (pkgs: pkgs.nixfmt);
    };
}
