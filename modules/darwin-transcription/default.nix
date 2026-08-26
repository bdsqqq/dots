{ config, lib, pkgs, ... }:

let
  cfg = config.my.darwinTranscription;
  home = config.users.users.${cfg.user}.home;
  package = import ./package.nix {
    inherit pkgs;
    inherit (cfg)
      defaultProfiles
      modelDirectory
      outputDirectory
      profileDirectory
      stateDirectory
      whisperBinary
      ;
  };
in
{
  options.my.darwinTranscription = {
    enable = lib.mkEnableOption "local Apple Silicon transcription pipeline";

    user = lib.mkOption {
      type = lib.types.str;
      default = config.my.primaryUser;
      description = "user that owns transcription state and runs jobs";
    };

    defaultProfiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "igor=${home}/commonplace/01_files/_utilities/speaker-profiles/igor-pt-clean.ecapa.json"
      ];
      description = "speaker profiles included in every mono transcription";
    };

    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/Library/Application Support/darwin-transcription";
      description = "private mutable state and model runtime cache";
    };

    modelDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/Library/Caches/darwin-transcription/models";
      description = "verified ASR, VAD, and ECAPA model artifacts";
    };

    profileDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/commonplace/01_files/_utilities/speaker-profiles";
      description = "durable ECAPA speaker centroids";
    };

    outputDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${home}/commonplace/02_temp/darwin-transcription";
      description = "versioned working transcription outputs";
    };

    whisperBinary = lib.mkOption {
      type = lib.types.str;
      default = "${config.homebrew.prefix}/bin/whisper-cli";
      description = "Homebrew whisper.cpp CLI with Metal and current VAD support";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.isDarwin;
        message = "my.darwinTranscription is supported only on Darwin";
      }
    ];

    # nixpkgs currently trails the whisper.cpp version used by proven local
    # runs. keep that mutable boundary explicit and verify it in `doctor`.
    homebrew.brews = [ "whisper-cpp" ];

    home-manager.users.${cfg.user} = { lib, ... }: {
      home.packages = [
        package
        pkgs.ffmpeg
      ];
      home.activation.darwinTranscriptionDirectories =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          install -d -m 0700 \
            ${lib.escapeShellArg cfg.stateDirectory} \
            ${lib.escapeShellArg cfg.modelDirectory} \
            ${lib.escapeShellArg cfg.outputDirectory}
          install -d -m 0750 ${lib.escapeShellArg cfg.profileDirectory}
        '';
    };
  };
}
