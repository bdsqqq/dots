{ config, ... }:

{
  # macOS still requires disabling FileVault and entering the account password
  # once in System Settings. Never store that password in Nix.
  system.defaults.loginwindow.autoLoginUser = config.my.primaryUser;
}
