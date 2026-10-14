package tasks

import (
	"testing"
	"time"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/internal/oplog"
	"github.com/garethgeorge/backrest/internal/oplog/sqlitestore"
)

// Exercise the real persisted-history lookup used after a daemon restart.
// A failed completed backup is an attempt, not a successful-snapshot anchor.
func TestNixScheduleHistory(t *testing.T) {
	last := mustParseTime(t, "2026-10-10T01:05:00Z")
	now := mustParseTime(t, "2026-10-13T12:00:00Z")
	repo := &v1.Repo{Id: "fixture-repo", Guid: "fixture-guid"}
	plan := &v1.Plan{Id: "fixture-plan", Repo: repo.Id, Schedule: &v1.Schedule{
		Schedule: &v1.Schedule_Cron{Cron: "0 1 * * *"},
		Clock: v1.Schedule_CLOCK_LAST_RUN_TIME,
	}}
	cfg := newTestConfig(repo, plan)
	for _, tc := range []struct {
		name string
		status v1.OperationStatus
		dryRun bool
		want string
	}{
		{"overdue success", v1.OperationStatus_STATUS_SUCCESS, false, "2026-10-14T01:00:00Z"},
		{"failed attempt counts", v1.OperationStatus_STATUS_ERROR, false, "2026-10-14T01:00:00Z"},
		{"guard user cancellation counts until startup cleanup", v1.OperationStatus_STATUS_USER_CANCELLED, false, "2026-10-14T01:00:00Z"},
		{"system cancellation ignored", v1.OperationStatus_STATUS_SYSTEM_CANCELLED, false, "2026-10-11T01:00:00Z"},
		{"pending ignored", v1.OperationStatus_STATUS_PENDING, false, "2026-10-11T01:00:00Z"},
		{"dry run ignored", v1.OperationStatus_STATUS_SUCCESS, true, "2026-10-11T01:00:00Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, err := sqlitestore.NewMemorySqliteStore(t)
			if err != nil { t.Fatal(err) }
			for i, end := range []time.Time{last, now} {
				status, dryRun := v1.OperationStatus_STATUS_SUCCESS, false
				if i == 1 { status, dryRun = tc.status, tc.dryRun }
				if err := store.Add(&v1.Operation{
					InstanceId: cfg.Instance, RepoId: repo.Id, RepoGuid: repo.Guid, PlanId: plan.Id,
					Status: status, UnixTimeStartMs: end.Add(-time.Minute).UnixMilli(), UnixTimeEndMs: end.UnixMilli(),
					Op: &v1.Operation_OperationBackup{OperationBackup: &v1.OperationBackup{DryRun: dryRun}},
				}); err != nil { t.Fatal(err) }
			}
			log, err := oplog.NewOpLog(store)
			if err != nil { t.Fatal(err) }
			// New task + runner models restart, retaining only operation history.
			task := NewScheduledBackupTask(repo, plan)
			got, err := task.Next(now, newTestTaskRunner(t, cfg, log))
			if err != nil || !got.RunAt.Equal(mustParseTime(t, tc.want)) {
				t.Fatalf("got %v, %v; want %s", got.RunAt, err, tc.want)
			}
		})
	}
	t.Run("no history waits a full interval", func(t *testing.T) {
		plan.Schedule = &v1.Schedule{Schedule: &v1.Schedule_MaxFrequencyHours{MaxFrequencyHours: 1}, Clock: v1.Schedule_CLOCK_LAST_RUN_TIME}
		runner := setupTestRunner(t, cfg, &fakeRepoOrchestrator{})
		before := time.Now()
		got, err := NewScheduledBackupTask(repo, plan).Next(before, runner)
		after := time.Now()
		if err != nil || got.RunAt.Before(before.Add(time.Hour)) || got.RunAt.After(after.Add(time.Hour)) {
			t.Fatalf("first run should wait an hour: %v, %v", got.RunAt, err)
		}
	})
}
