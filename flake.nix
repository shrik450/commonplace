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
        default = pkgs.mkShell (
          {
            packages = [
              pkgs.bun
              pkgs.chromium
              pkgs.just
              pkgs.podman
            ];
            # The browser tests and screenshot tool drive this Chromium through
            # playwright-core, which never downloads a browser of its own.
            COMMONPLACE_TEST_BROWSER = "${pkgs.chromium}/bin/chromium";
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            # Tailwind's file watcher is a prebuilt native module that links
            # against libstdc++, which NixOS doesn't put on the default path.
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
          }
        );
      });

      formatter = forEachSystem (pkgs: pkgs.nixfmt);
    };
}
