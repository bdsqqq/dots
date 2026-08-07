final: prev:
let
  version = "0.16.0";
  platform =
    if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isAarch64 then
      {
        name = "darwin_arm64";
        hash = "sha256-Jx+0uV2lbJeZaEoThsBxtqe6WGccJ8tN4PIjdHTJ9KA=";
      }
    else if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isx86_64 then
      {
        name = "darwin_amd64";
        hash = "sha256-uMMJy+C9cXaOiU5V+dFMG7xbOvFtdvimADNIBHbv0BI=";
      }
    else
      throw "unsupported platform for axiom-cli: ${final.stdenv.hostPlatform.system}";
in
{
  axiom-cli = final.stdenvNoCC.mkDerivation {
    pname = "axiom-cli";
    inherit version;

    src = prev.fetchurl {
      url = "https://github.com/axiomhq/cli/releases/download/v${version}/axiom_${version}_${platform.name}.tar.gz";
      inherit (platform) hash;
    };

    nativeBuildInputs = [ final.installShellFiles ];

    installPhase = ''
      runHook preInstall
      install -Dm755 axiom "$out/bin/axiom"
      installManPage man/*.1
      installShellCompletion \
        --bash completions/axiom.bash \
        --fish completions/axiom.fish \
        --zsh completions/_axiom
      runHook postInstall
    '';

    meta = with final.lib; {
      description = "Axiom command-line interface";
      homepage = "https://github.com/axiomhq/cli";
      changelog = "https://github.com/axiomhq/cli/releases/tag/v${version}";
      license = licenses.mit;
      mainProgram = "axiom";
      platforms = platforms.darwin;
      sourceProvenance = [ sourceTypes.binaryNativeCode ];
    };
  };
}
