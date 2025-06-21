# Tier 3 Migration Cleanup Guide

## Overview

This guide helps you remove the successfully migrated homebrew packages after applying the Tier 3 migration.

## Pre-Cleanup Verification

First, apply the configuration:
```bash
sudo darwin-rebuild switch --flake .
```

Then verify all tools work from nix:
```bash
# Container & Docker tools
lazydocker --version
dive --version
ctop --version

# Development tools  
swagger-codegen version
swagger --version
go-swagger version

# Media processing
ffmpeg -version

# Database & backend
supabase --version

# Cloud & Infrastructure
aws --version
az --version

# HTTP/API testing
http --version

# System monitoring
htop --version

# DevOps
ansible --version
```

## Homebrew Cleanup Commands

Once verified, remove the homebrew packages:

```bash
# Remove migrated packages from homebrew
brew uninstall lazydocker
brew uninstall swagger-codegen
brew uninstall supabase-cli
brew uninstall awscli
brew uninstall azure-cli
brew uninstall httpie
brew uninstall htop
brew uninstall dive
brew uninstall ctop
brew uninstall ansible

# Note: ffmpeg might have dependencies, check before removing:
brew uninstall --ignore-dependencies ffmpeg

# Verify removals
brew list | grep -E "(lazydocker|swagger|supabase|aws|azure|httpie|htop|dive|ctop|ansible|ffmpeg)"
```

## Expected Results

- **Before cleanup:** ~216 homebrew packages
- **After cleanup:** ~202 homebrew packages  
- **Reduction:** 14 packages successfully migrated to nix

## Rollback Plan

If any issues occur, you can reinstall via homebrew:
```bash
brew install lazydocker swagger-codegen supabase-cli awscli azure-cli httpie htop dive ctop ansible ffmpeg
```

## Verification

After cleanup, verify your workflow still works:
- Docker container management with `lazydocker`
- API testing with `http` (httpie)
- System monitoring with `htop`
- Cloud deployments with `aws` and `az`
- Infrastructure automation with `ansible`

## Next Steps

Consider Tier 4 migration for:
- Language-specific tools (Java, .NET, etc.)
- Additional development utilities
- Specialized productivity tools

Target: Further reduce homebrew dependencies while maintaining workflow quality.
