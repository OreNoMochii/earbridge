import ExpoModulesCore

final class OnDeviceException: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String { message }

  override var code: String { "ERR_ON_DEVICE" }
}

/** Errors as the app shows them: the message alone. */
private func onDevice<T>(_ work: () async throws -> T) async throws -> T {
  do {
    return try await work()
  } catch let error as Exception {
    throw error
  } catch {
    throw OnDeviceException(error.localizedDescription)
  }
}

/**
 Speech recognition and translation that run on the iPhone itself, with no server: the same
 module as on Android (EarbridgeOnDeviceModule.kt), with Apple's engines behind it (iOS 26
 and newer). See OnDeviceRecognition.swift and OnDeviceTranslation.swift.
 */
public final class EarbridgeOnDeviceModule: Module {
  private let recognition = OnDeviceRecognition()
  @MainActor private lazy var translation = OnDeviceTranslation()

  public func definition() -> ModuleDefinition {
    Name("EarbridgeOnDevice")
    Events("onRecognition", "onDownloadProgress")

    OnCreate {
      self.recognition.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnDestroy {
      self.recognition.shutDown()
      _ = Task { @MainActor in self.translation.close() }
    }

    Function("isAvailable") { () -> Bool in
      OnDeviceRecognition.isAvailable
    }

    AsyncFunction("recognitionLanguages") { () async throws -> [String: [String]] in
      try await onDevice { try await self.recognition.languages() }
    }

    // Resolves "done" once the language is on the phone.
    AsyncFunction("downloadRecognition") { (language: String) async throws -> String in
      try await onDevice { try await self.recognition.download(language) }
    }

    // The audio: 16 kHz 16-bit mono PCM, written as it is recorded and ended with endAudio.
    Function("startRecognition") { (session: Int, language: String) throws in
      do {
        try self.recognition.start(session, language)
      } catch {
        throw OnDeviceException(error.localizedDescription)
      }
    }

    Function("writeAudio") { (session: Int, pcm: Data) in
      self.recognition.write(session, pcm)
    }

    // Recognizes the rest of what was written, then reports "end".
    Function("endAudio") { (session: Int) in
      self.recognition.end(session)
    }

    // Stops at once; reports "end" too.
    Function("cancelRecognition") { (session: Int) in
      self.recognition.cancel(session)
    }

    // iOS does not list its translation languages; prepareTranslation finds out per pair.
    AsyncFunction("translationModels") { () -> [String] in
      []
    }

    // Asks iOS to download what the language pair needs, unless it is already there.
    AsyncFunction("prepareTranslation") { (source: String, target: String) async throws in
      try await onDevice { try await self.translation.prepare(source, target) }
    }

    AsyncFunction("translate") { (source: String, target: String, text: String) async throws -> String in
      try await onDevice { try await self.translation.translate(source, target, text) }
    }

    Function("closeTranslation") {
      _ = Task { @MainActor in self.translation.close() }
    }
  }
}
