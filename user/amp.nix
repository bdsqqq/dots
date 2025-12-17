{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, config, ... }: 
  let
    skillsDir = "${config.home.homeDirectory}/.amp/skills";
    
    gitShipSkill = ''
      ---
      name: git-ship
      description: stage all changes, commit with conventional commits format, and push to remote
      ---
      # git-ship

      execute this deterministically without extensive analysis.

      ## workflow

      1. run `git add -A && git status` to stage and review changes
      2. analyze the diff with `git diff --staged` to understand what changed
      3. generate a commit message following conventional commits:
         - format: `type(scope): description`
         - types: feat, fix, docs, style, refactor, perf, test, chore
         - lowercase, imperative mood
         - if multiple logical changes, use bullet points in body
      4. run `git commit -m "..."` with the generated message
      5. run `git push`

      ## commit message examples

      simple:
      ```
      feat(auth): add jwt token refresh endpoint
      ```

      with body:
      ```
      feat(console): add UI source viewer for components

      - import source files at build time via import.meta.glob
      - parse source into JSDoc and code blocks
      - add 'UI Source' section to design sidebar
      ```
    '';

    gitWorktreeSkill = ''
      ---
      name: git-worktree
      description: create a new git worktree with a branch and switch to it
      ---
      # git-worktree

      execute this deterministically without extensive analysis.

      ## workflow

      1. ask for the worktree/branch name if not provided
      2. determine the worktree path: `../<name>` (sibling to current repo)
      3. run `git worktree add ../<name> -b <name>`
      4. confirm the worktree was created with `git worktree list`
      5. tell the user to `cd ../<name>` to switch (or open in their editor)

      ## example

      user says: "create a worktree for feature-auth"

      ```bash
      git worktree add ../feature-auth -b feature-auth
      git worktree list
      ```

      then tell user: `cd ../feature-auth` or open that directory in their editor.
    '';
  in {
    # amp skills directory
    home.file.".amp/skills/git-ship/SKILL.md" = {
      force = true;
      text = gitShipSkill;
    };
    
    home.file.".amp/skills/git-worktree/SKILL.md" = {
      force = true;
      text = gitWorktreeSkill;
    };

    # shell wrappers for rush mode execution
    home.shellAliases = {
      # ship: commit and push in rush mode, continuing current thread
      ship = "amp --mode rush -x 'use the git-ship skill'";
      
      # wt: create worktree in rush mode  
      wt = "amp --mode rush -x 'use the git-worktree skill'";
    };
  };
}
