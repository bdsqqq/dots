#include <dispatch/dispatch.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <xpc/xpc.h>

extern char **environ;

static void apply_mapping(void) {
  char *const arguments[] = {
      "/usr/bin/hidutil",
      "property",
      "--matching",
      "{\"VendorID\":11427,\"ProductID\":16401}",
      "--set",
      "{\"UserKeyMapping\":[{\"HIDKeyboardModifierMappingSrc\":51539607785,"
      "\"HIDKeyboardModifierMappingDst\":30064771181}]}",
      NULL,
  };

  pid_t child;
  int error = posix_spawn(&child, arguments[0], NULL, NULL, arguments, environ);
  if (error != 0) {
    errno = error;
    perror("posix_spawn hidutil");
    return;
  }

  int status;
  pid_t waited;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited == -1 && errno == EINTR);

  if (waited == -1) {
    perror("waitpid hidutil");
  } else if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    fprintf(stderr, "hidutil failed: status=%d\n", status);
  }
}

int main(void) {
  /*
   * launchd may drop streamed events if their consumer exits. Keep this
   * process alive so reconnects reapply hidutil's per-device mapping.
   */
  xpc_set_event_stream_handler(
      "com.apple.iokit.matching", dispatch_get_main_queue(),
      ^(xpc_object_t event) {
        (void)event;
        apply_mapping();
      });

  /* Cover a receiver that was already attached when the agent started. */
  apply_mapping();
  dispatch_main();
}
