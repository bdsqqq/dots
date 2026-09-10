#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <xpc/xpc.h>

extern char **environ;

static CFMachPortRef event_tap;

static bool rewrite_f18(CGEventType type, CGEventRef event) {
  if (type != kCGEventKeyDown && type != kCGEventKeyUp)
    return false;

  CGKeyCode keycode =
      (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if (keycode != kVK_F18)
    return false;

  /*
   * F18 is reserved session-wide as the DJI sentinel, so a physical F18 key
   * intentionally shares this behavior. Replacing its secondary-Fn flag also
   * keeps terminals from encoding the otherwise unhandled function key.
   */
  CGEventSetIntegerValueField(event, kCGKeyboardEventKeycode, kVK_Space);
  CGEventSetFlags(event, kCGEventFlagMaskControl | kCGEventFlagMaskAlternate |
                            kCGEventFlagMaskCommand);
  CGEventKeyboardSetUnicodeString(event, 0, NULL);
  return true;
}

static CGEventRef handle_keyboard_event(CGEventTapProxy proxy, CGEventType type,
                                        CGEventRef event, void *context) {
  (void)proxy;
  (void)context;

  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    CGEventTapEnable(event_tap, true);
    return event;
  }

  rewrite_f18(type, event);
  return event;
}

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

static int run_self_test(void) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, kVK_F18, true);
  if (event == NULL)
    return 1;

  CGEventSetFlags(event, kCGEventFlagMaskSecondaryFn);
  bool rewritten = rewrite_f18(kCGEventKeyDown, event);
  CGKeyCode keycode =
      (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  CGEventFlags flags = CGEventGetFlags(event);
  CFRelease(event);

  CGEventFlags expected_flags = kCGEventFlagMaskControl |
                               kCGEventFlagMaskAlternate |
                               kCGEventFlagMaskCommand;
  return rewritten && keycode == kVK_Space && flags == expected_flags ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0)
    return run_self_test();

  /*
   * launchd may drop streamed events if their consumer exits. Keep this
   * process alive so reconnects reapply hidutil's per-device mapping.
   */
  xpc_set_event_stream_handler(
      "com.apple.iokit.matching",
      dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
      ^(xpc_object_t event) {
        (void)event;
        apply_mapping();
      });

  /* Cover a receiver that was already attached when the agent started. */
  apply_mapping();

  CGEventMask mask =
      CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp);
  event_tap = CGEventTapCreate(
      kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask,
      handle_keyboard_event, NULL);
  if (event_tap == NULL) {
    fprintf(stderr,
            "cannot create event tap; grant Accessibility permission to this "
            "executable\n");
    return 77;
  }

  CFRunLoopSourceRef source =
      CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(event_tap, true);
  CFRunLoopRun();
}
