{ config, lib, pkgs }:
let
  drive = builtins.fromJSON (builtins.readFile ./drive.json);
  cfg = config.my.ssd01Backup;
  passwordFile = config.sops.secrets.restic_ssd_01_password.path;
  sshCommand = lib.escapeShellArgs [
    "${pkgs.openssh}/bin/ssh"
    "-p"
    (toString drive.repository.sshPort)
    "-o"
    "BatchMode=yes"
    "-o"
    "IdentitiesOnly=yes"
    "-o"
    "IdentityAgent=none"
    "-o"
    "StrictHostKeyChecking=yes"
    "-o"
    "UserKnownHostsFile=${cfg.knownHostsPath}"
    "-o"
    "GlobalKnownHostsFile=/dev/null"
    "-o"
    "UpdateHostKeys=no"
    "-o"
    "ConnectionAttempts=1"
    "-o"
    "ConnectTimeout=10"
    "-o"
    "ServerAliveInterval=5"
    "-o"
    "ServerAliveCountMax=1"
    "-i"
    cfg.sshKeyPath
    drive.repository.sshTarget
    "-s"
    "sftp"
  ];
in
{ inherit passwordFile sshCommand; }
