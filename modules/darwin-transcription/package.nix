{ pkgs
, defaultProfiles ? [ ]
, modelDirectory ? "$HOME/Library/Caches/darwin-transcription/models"
, outputDirectory ? "$HOME/commonplace/02_temp/darwin-transcription"
, profileDirectory ? "$HOME/commonplace/01_files/_utilities/speaker-profiles"
, stateDirectory ? "$HOME/Library/Application Support/darwin-transcription"
, whisperBinary ? "/opt/homebrew/bin/whisper-cli"
}:

let
  python = pkgs.python3.withPackages (packages: [
    packages.huggingface-hub
    packages.numpy
    packages.soundfile
    packages.speechbrain
    packages.torch
    packages.torchaudio
  ]);
in
pkgs.writeShellApplication {
  name = "darwin-transcription";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.curl
    pkgs.ffmpeg
    python
  ];
  text = ''
    export PYTHONNOUSERSITE=1
    export HF_HOME=${pkgs.lib.escapeShellArg "${stateDirectory}/huggingface"}
    export DARWIN_TRANSCRIPTION_MODEL_DIR=${pkgs.lib.escapeShellArg modelDirectory}
    export DARWIN_TRANSCRIPTION_DEFAULT_PROFILES_JSON=${pkgs.lib.escapeShellArg (builtins.toJSON defaultProfiles)}
    export DARWIN_TRANSCRIPTION_OUTPUT_DIR=${pkgs.lib.escapeShellArg outputDirectory}
    export DARWIN_TRANSCRIPTION_PROFILE_DIR=${pkgs.lib.escapeShellArg profileDirectory}
    export DARWIN_TRANSCRIPTION_STATE_DIR=${pkgs.lib.escapeShellArg stateDirectory}
    export DARWIN_TRANSCRIPTION_WHISPER_CLI=${pkgs.lib.escapeShellArg whisperBinary}
    exec python ${./darwin_transcription.py} "$@"
  '';
}
