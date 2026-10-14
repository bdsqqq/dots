package protoutil_test

import (
	"os"
	"strings"
	"testing"
	"time"
	_ "time/tzdata"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	configutil "github.com/garethgeorge/backrest/internal/config"
	"github.com/garethgeorge/backrest/internal/protoutil"
	"google.golang.org/protobuf/encoding/protojson"
)

// Validate the generated JSON with the same parser the unpatched daemon uses.
// This runs during the consuming package build, not against a live repository.
func TestNixNativeGeneratedConfig(t *testing.T) {
	path := os.Getenv("NIX_BACKUP_CONFIG")
	if path == "" {
		t.Skip("generated config supplied by the package's postCheck")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := &v1.Config{}
	if err := protojson.Unmarshal(data, config); err != nil {
		t.Fatal(err)
	}
	if err := configutil.ValidateConfig(config); err != nil {
		t.Fatal(err)
	}
	// Prove the full-config verifier catches a daemon startup failure.
	config.Repos = append(config.Repos, &v1.Repo{
		Id: "fixture-invalid-identity", Uri: "/unused",
		Guid: strings.Repeat("0", 64), AutoInitialize: true,
	})
	if err := configutil.ValidateConfig(config); err == nil || !strings.Contains(err.Error(), "auto_initialize set with guid") {
		t.Fatalf("expected conflicting identity rejection, got %v", err)
	}
}

func TestNixNativeSchedule(t *testing.T) {
	// Upstream interprets cron in the daemon location, even with CLOCK_UTC.
	zone, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	oldLocal := time.Local
	time.Local = zone
	t.Cleanup(func() { time.Local = oldLocal })
	parse := func(value string) time.Time {
		t.Helper()
		result, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	last := parse("2026-10-10T01:05:00Z")
	now := parse("2026-10-13T12:00:00Z")
	for _, tc := range []struct {
		name  string
		clock v1.Schedule_Clock
		want  string
	}{
		{"overdue last-attempt anchor", v1.Schedule_CLOCK_LAST_RUN_TIME, "2026-10-11T01:00:00Z"},
		{"local skips missed occurrences", v1.Schedule_CLOCK_LOCAL, "2026-10-14T01:00:00Z"},
		{"default is local", v1.Schedule_CLOCK_DEFAULT, "2026-10-14T01:00:00Z"},
		{"UTC anchor does not change cron timezone", v1.Schedule_CLOCK_UTC, "2026-10-14T01:00:00Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			schedule := &v1.Schedule{Schedule: &v1.Schedule_Cron{Cron: "0 22 * * *"}, Clock: tc.clock}
			got, err := protoutil.ResolveSchedule(schedule, last, now)
			if err != nil || !got.Equal(parse(tc.want)) {
				t.Fatalf("got %v, %v; want %s", got, err, tc.want)
			}
		})
	}
	// Known failures must be rejected; do not write another cron parser in Nix.
	for _, expr := range []string{"", "not cron", "61 22 * * *", "TZ=America/Sao_Paulo 0 22 * * *"} {
		if err := protoutil.ValidateSchedule(&v1.Schedule{Schedule: &v1.Schedule_Cron{Cron: expr}}); err == nil {
			t.Fatalf("accepted invalid native cron %q", expr)
		}
	}
}
