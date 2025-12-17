{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, config, ... }: 
  let
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

    # source: https://github.com/tldraw/tldraw/blob/main/.claude/commands/clean-copy.md
    cleanCopySkill = ''
      ---
      name: clean-copy
      description: reimplement current branch with clean, narrative-quality git commit history
      ---
      # clean-copy

      > source: https://github.com/tldraw/tldraw/blob/main/.claude/commands/clean-copy.md

      Reimplement the current branch on a new branch with a clean, narrative-quality git commit history suitable for reviewer comprehension.

      **New Branch Name**. Decide on the new branch name. The name should be $ARGUMENTS or, if this is not provided, it should be `{source_branch_name}-clean`.

      ### Steps

      1. **Validate the source branch**
         - The current branch is the source branch.
         - Ensure the current branch has no merge conflicts, uncommitted changes, or other issues.
         - Confirm it is up to date with `main`.

      2. **Analyze the diff**
         - Study all changes between the current source branch and `main`.
         - Form a clear understanding of the final intended state.

      3. **Create the clean branch**
         - Create a new branch off of main using the New Branch Name.

      4. **Plan the commit storyline**
         - Break the implementation down into a sequence of self-contained steps.
         - Each step should reflect a logical stage of development—as if writing a tutorial.

      5. **Reimplement the work**
         - Recreate the changes in the clean branch, committing step by step according to your plan.
         - Each commit must:
           - Introduce a single coherent idea.
           - Include a clear commit message and description.
           - Add comments or inline GitHub comments when needed to explain intent.

      6. **Verify correctness**
         - Confirm that the final state of `{branch_name}-clean` exactly matches the final state of the original branch.
         - Use `--no-verify` only when necessary (e.g., to bypass known issues). Individual commits do not need to pass tests, but this should be rare.

      7. **Open a pull request**
         - Create a PR from the clean branch to `main`.
         - Write the PR following the instructions in `pr.md`.
         - Include a link to the original branch.

      There may be cases where you will need to push commits with --no-verify in order to avoid known issues. It is not necessary that every commit pass tests or checks, though this should be the exception if you're doing your job correctly. It is essential that the end state of your new branch be identical to the end state of the source branch.

      ### Misc

      1. Never add yourself as an author or contributor on any branch or commit.
      2. Write your pull request following the same instructions as in the pr.md command file.
      3. In your pull request, include a link to the original branch.

      Your commit should never include lines like:

      ```md
      🤖 Generated with [Claude Code](https://claude.com/claude-code)
      ```

      or

      ```md
      Co-Authored-By: Claude Sonnet 4.5 
      ```

      Or else I'll get in trouble with my boss.
    '';
  in {
    # amp skills directory
    home.file.".config/amp/skills/git-ship/SKILL.md" = {
      force = true;
      text = gitShipSkill;
    };
    
    home.file.".config/amp/skills/git-worktree/SKILL.md" = {
      force = true;
      text = gitWorktreeSkill;
    };

    home.file.".config/amp/skills/clean-copy/SKILL.md" = {
      force = true;
      text = cleanCopySkill;
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
