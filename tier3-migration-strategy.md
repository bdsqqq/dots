# Tier 3 Migration Strategy - Complex Tools Evaluation

**Current Status:** 170 homebrew packages remaining (better than reported 216)

## Tier 3A - High-Value Migration Targets (Est. 15-20 packages)

### Container/Docker Tools
- `lazydocker` → Available in nixpkgs as `lazydocker`
- Docker ecosystem tools → Most available in nix

### Language-Specific CLI Tools  
- `vercel-cli` → Available as `nodePackages.vercel`
- `supabase` → Available in nixpkgs as `supabase-cli`
- `swagger-codegen` → Available as `swagger-codegen3`
- `swagger-codegen@2` → Keep in homebrew (legacy version)

### Media/FFmpeg Ecosystem
- `ffmpeg` → Available in nixpkgs with extensive options
- Related: `aom`, `dav1d`, `fftw`, `flac` → All available in nix

## Tier 3B - Consolidation Opportunities (Est. 10-15 packages)

### Development Dependencies
- `gcc`, `bash`, `ca-certificates` → May be needed by other tools
- `fontconfig`, `freetype`, `cairo` → Graphics stack dependencies

### Media Processing Stack
- `aom`, `dav1d`, `fftw`, `flac`, `frei0r`, `fribidi` → FFmpeg dependencies

## Migration Strategy

### Phase 1: Language-Specific Tools (5-8 packages)
```nix
environment.systemPackages = with pkgs; [
  lazydocker
  nodePackages.vercel
  supabase-cli
  swagger-codegen3
];
```

### Phase 2: Media Processing (8-12 packages) 
```nix
ffmpeg-full  # Includes most codec dependencies
# OR
(ffmpeg.override {
  withFdkAac = true;
  withFontconfig = true;
  # etc.
})
```

### Phase 3: Development Dependencies (5-10 packages)
- Evaluate if needed independently or as nix-shell deps
- Consider moving to project-specific shells

## Risk Assessment

### Low Risk (Proceed)
- `lazydocker`, `vercel-cli`, `supabase` - Direct nix equivalents
- `ffmpeg` ecosystem - Well-supported in nix

### Medium Risk (Test First)  
- Version-specific tools (`swagger-codegen@2`)
- Mac-specific media tools

### High Risk (Keep in Homebrew)
- Legacy/pinned versions
- Tools with complex system integrations

## Realistic Estimates

**Optimistic:** 25-30 package reduction (down to ~140)
**Conservative:** 15-20 package reduction (down to ~150-155) 
**Realistic:** 20-25 package reduction (down to ~145-150)

## Next Actions

1. Test `lazydocker` and container tools in nix
2. Verify `ffmpeg` configuration covers current use cases  
3. Check if development dependencies are actually needed
4. Create test script for Tier 3A migration
