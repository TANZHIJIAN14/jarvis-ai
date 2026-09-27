// Push to talk: a global F5 hot key (Carbon, so no Accessibility permission is needed) that
// reports both the press and the release. Not Right Option: OpenSuperWhisper uses that.

import Carbon.HIToolbox

final class PushToTalkKey {
  private var hotKey: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let onChange: (Bool) -> Void
  private var down = false

  init(onChange: @escaping (Bool) -> Void) {
    self.onChange = onChange
  }

  func register() {
    var types = [
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
    ]
    let this = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
      guard let event, let context else { return noErr }
      let key = Unmanaged<PushToTalkKey>.fromOpaque(context).takeUnretainedValue()
      key.changed(GetEventKind(event) == UInt32(kEventHotKeyPressed))
      return noErr
    }, types.count, &types, this, &handler)
    let id = EventHotKeyID(signature: OSType(0x4A525653), id: 1) // "JRVS"
    RegisterEventHotKey(UInt32(kVK_F5), 0, id, GetApplicationEventTarget(), 0, &hotKey)
  }

  private func changed(_ pressed: Bool) {
    guard pressed != down else { return } // key repeat sends more presses
    down = pressed
    onChange(pressed)
  }
}
