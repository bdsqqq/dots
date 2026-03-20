inputs: final: prev:
let
  version = "0.4.2";
  src = prev.fetchFromGitHub {
    owner = "neurosnap";
    repo = "zmx";
    rev = "v${version}";
    hash = "sha256-ehbriI3xW40oVUbokhNuxYvueqFhkmHCVNZpqxQLr3A=";
  };

  artifact =
    if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isAarch64 then prev.fetchurl {
      url = "https://zmx.sh/a/zmx-0.4.2-macos-aarch64.tar.gz";
      hash = "sha256-V9SYOm6n7VwEt4ebkNQ0zCAtwLY3ysgK59WuCbQesWA=";
    }
    else if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isx86_64 then prev.fetchurl {
      url = "https://zmx.sh/a/zmx-0.4.2-macos-x86_64.tar.gz";
      hash = "sha256-GunNG+i69eUaaci6kVZpip+DPgiRFmQoEbhaRE4mJ8c=";
    }
    else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isAarch64 then prev.fetchurl {
      url = "https://zmx.sh/a/zmx-0.4.2-linux-aarch64.tar.gz";
      hash = "sha256-Lj/CpiV0CGJmNEgOWmhMwk5ys0+BPQiwCKNZ+VDvyjs=";
    }
    else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isx86_64 then prev.fetchurl {
      url = "https://zmx.sh/a/zmx-0.4.2-linux-x86_64.tar.gz";
      hash = "sha256-JSPSkAbo4NdoyA9APK0pROkNWMuj9oqRJ3sLgNDB8jc=";
    }
    else throw "unsupported platform for zmx: ${final.stdenv.hostPlatform.system}";
in {
  zmx = final.stdenv.mkDerivation {
    pname = "zmx";
    inherit version src;

    dontUnpack = true;

    installPhase = ''
      runHook preInstall
      mkdir -p "$out/bin"
      tar -xzf "${artifact}" -C "$out/bin"
      chmod +x "$out/bin/zmx"
      runHook postInstall
    '';

    meta = with final.lib; {
      description = "session persistence for terminal processes";
      homepage = "https://github.com/neurosnap/zmx";
      changelog = "https://github.com/neurosnap/zmx/blob/v${version}/CHANGELOG.md";
      license = licenses.mit;
      mainProgram = "zmx";
      platforms = platforms.darwin ++ platforms.linux;
      sourceProvenance = [ sourceTypes.binaryNativeCode ];
    };
  };
}
