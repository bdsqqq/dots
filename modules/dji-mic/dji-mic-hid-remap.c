#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>
#include <arpa/inet.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <xpc/xpc.h>

extern char **environ;

static CFMachPortRef event_tap;
static dispatch_queue_t dictation_queue;
static dispatch_source_t kanata_drain_timer;
static int kanata_socket = -1;
static bool release_pending = true;
static const char press_message[] =
    "{\"ActOnFakeKey\":{\"name\":\"dji-dictation\",\"action\":\"Press\"}}";
static const char release_message[] =
    "{\"ActOnFakeKey\":{\"name\":\"dji-dictation\",\"action\":\"Release\"}}";

static bool is_f18(CGEventType type, CGEventRef event) {
  if (type != kCGEventKeyDown && type != kCGEventKeyUp)
    return false;

  CGKeyCode keycode =
      (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  return keycode == kVK_F18;
}

static void disconnect_kanata(void) {
  if (kanata_socket == -1)
    return;

  close(kanata_socket);
  kanata_socket = -1;
}

static bool connect_kanata(void) {
  kanata_socket = socket(AF_INET, SOCK_STREAM, 0);
  if (kanata_socket == -1) {
    perror("socket");
    return false;
  }

  int no_sigpipe = 1;
  if (setsockopt(kanata_socket, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                 sizeof(no_sigpipe)) == -1) {
    perror("setsockopt SO_NOSIGPIPE");
    disconnect_kanata();
    return false;
  }

  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(5829),
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  if (connect(kanata_socket, (struct sockaddr *)&address, sizeof(address)) ==
      -1) {
    perror("connect kanata");
    disconnect_kanata();
    return false;
  }

  return true;
}

static void drain_kanata_messages(void) {
  if (kanata_socket == -1)
    return;

  char buffer[1024];
  for (;;) {
    ssize_t result =
        recv(kanata_socket, buffer, sizeof(buffer), MSG_DONTWAIT);
    if (result > 0)
      continue;
    if (result == -1 && errno == EINTR)
      continue;
    if (result == -1 && (errno == EAGAIN || errno == EWOULDBLOCK))
      return;

    disconnect_kanata();
    return;
  }
}

static bool send_kanata_message(const char *message) {
  size_t message_length = strlen(message);
  size_t sent = 0;
  while (sent < message_length) {
    ssize_t result =
        send(kanata_socket, message + sent, message_length - sent, 0);
    if (result == -1) {
      if (errno == EINTR)
        continue;
      return false;
    }
    if (result == 0)
      return false;
    sent += (size_t)result;
  }

  return true;
}

static bool send_kanata_message_with_reconnect(const char *message) {
  drain_kanata_messages();
  int send_error = EIO;
  for (int attempt = 0; attempt < 2; attempt++) {
    if (kanata_socket == -1 && !connect_kanata())
      return false;
    if (send_kanata_message(message))
      return true;
    send_error = errno;
    disconnect_kanata();
  }

  errno = send_error;
  perror("send kanata");
  return false;
}

static void trigger_dictation(void) {
  /*
   * Kanata's virtual keyboard enters macOS before global-hotkey dispatch.
   * Event-tap rewrites and CGEventPost arrive too late for Raycast to accept.
   * Raycast also needs a measurable press; Kanata's zero-duration Tap action
   * produced incomplete modifier combinations in its shortcut recorder.
   */
  if (release_pending) {
    if (!send_kanata_message_with_reconnect(release_message))
      return;
    release_pending = false;
  }

  if (!send_kanata_message_with_reconnect(press_message))
    return;

  release_pending = true;
  usleep(120000);
  if (send_kanata_message_with_reconnect(release_message))
    release_pending = false;
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

  if (is_f18(type, event)) {
    /*
     * F18 is reserved session-wide as the DJI sentinel, so a physical F18 key
     * intentionally shares this behavior. Only key-down triggers the shortcut;
     * both halves are suppressed so terminals never encode the sentinel.
     */
    if (type == kCGEventKeyDown &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 0) {
      dispatch_async(dictation_queue, ^{
        trigger_dictation();
      });
    }
    return NULL;
  }

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

  bool matched = is_f18(kCGEventKeyDown, event);
  CFRelease(event);
  return matched ? 0 : 1;
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

  dictation_queue =
      dispatch_queue_create("com.bdsqqq.dji-mic-hid-remap.dictation", NULL);
  kanata_drain_timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dictation_queue);
  dispatch_source_set_timer(
      kanata_drain_timer,
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)NSEC_PER_SEC), NSEC_PER_SEC,
      NSEC_PER_MSEC * 100);
  dispatch_source_set_event_handler(kanata_drain_timer, ^{
    if (release_pending) {
      if (send_kanata_message_with_reconnect(release_message))
        release_pending = false;
    } else {
      drain_kanata_messages();
    }
  });
  dispatch_resume(kanata_drain_timer);

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
