package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// Exercise Backrest's actual argv construction without network or credentials.
// Its implicit nonempty sftp.args conflicts with restic's custom sftp.command.
func TestNixNativeSFTPTransport(t *testing.T) {
	configPath, shell := os.Getenv("NIX_BACKUP_CONFIG"), os.Getenv("NIX_TEST_SHELL")
	if configPath == "" || shell == "" {
		t.Skip("runtime inputs supplied by the consuming package")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &v1.Config{}
	if err := protojson.Unmarshal(data, cfg); err != nil {
		t.Fatal(err)
	}
	for _, source := range cfg.Repos {
		usesCommand := false
		for _, flag := range source.Flags {
			usesCommand = usesCommand || strings.Contains(flag, "sftp.command=")
		}
		if !usesCommand {
			continue
		}
		for _, negative := range []bool{false, true} {
			t.Run(source.Id+map[bool]string{false: "/configured", true: "/missing-empty-args"}[negative], func(t *testing.T) {
				dir := t.TempDir()
				capture := filepath.Join(dir, "argv")
				t.Setenv("NIX_SFTP_CAPTURE_ARGS", capture)
				fake := filepath.Join(dir, "restic")
				script := "#!" + shell + "\nprintf '%s\\n' \"$@\" > \"$NIX_SFTP_CAPTURE_ARGS\"\nprintf '{}\\n'\n"
				if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
				repoConfig := &v1.Repo{Id: source.Id, Uri: source.Uri, Env: source.Env}
				for _, flag := range source.Flags {
					if negative && strings.Contains(flag, "sftp.args") {
						continue
					}
					repoConfig.Flags = append(repoConfig.Flags, flag)
				}
				orch, err := NewRepoOrchestrator(cfg, repoConfig, fake)
				if err != nil {
					t.Fatal(err)
				}
				// Parsing the fake's placeholder config is irrelevant; captured argv
				// proves the production command path actually executed.
				_ = orch.Exists(context.Background())
				argv, err := os.ReadFile(capture)
				if err != nil {
					t.Fatal(err)
				}
				command, nonemptyArgs := false, false
				for _, arg := range strings.Split(string(argv), "\n") {
					command = command || strings.HasPrefix(arg, "sftp.command=")
					nonemptyArgs = nonemptyArgs || strings.HasPrefix(arg, "sftp.args=") && arg != "sftp.args="
				}
				if !command || (command && nonemptyArgs) != negative {
					t.Fatalf("custom command conflict = %v, want %v", command && nonemptyArgs, negative)
				}
			})
		}
	}
}
