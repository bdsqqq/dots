// Anim.qml
// Standardized animation for property transitions.
// Why: consistent motion prevents jarring inconsistencies. OutQuint easing
//      provides snappy starts with gentle deceleration — feels responsive
//      without abrupt stops. 100ms hits the sweet spot between perceived
//      speed and visual comprehension.
//
// Usage with Behavior:
//   Behavior on color { Anim {} }
//   Behavior on opacity { Anim {} }

import QtQuick

ColorAnimation {
    duration: 100
    easing.type: Easing.OutQuint
}
