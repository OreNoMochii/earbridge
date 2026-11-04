import Foundation
import SwiftUI
import Translation
#if canImport(UIKit)
import UIKit
#endif

private let NEEDS_IOS_26_TRANSLATION = OnDeviceError("On-phone translation needs iOS 26 or newer.")

/**
 Translation that runs on the iPhone itself: Apple's Translation framework (iOS 26 and newer,
 to translate outside a SwiftUI view). iOS downloads each language once, after asking.
 */
@MainActor
final class OnDeviceTranslation {
  /** TranslationSession by language pair ("en>ja"); AnyObject so the class needs no iOS 26. */
  private var sessions: [String: AnyObject] = [:]

  /** Gets a language pair ready, asking iOS to download it if it is not on the phone yet. */
  func prepare(_ source: String, _ target: String) async throws {
    guard #available(iOS 26.0, *) else { throw NEEDS_IOS_26_TRANSLATION }
    let from = Locale.Language(identifier: source)
    let to = Locale.Language(identifier: target)
    let status = await LanguageAvailability().status(from: from, to: to)
    if status == .installed { return }
    if status == .unsupported {
      throw OnDeviceError("On-phone translation doesn't support \"\(source)\" to \"\(target)\".")
    }
    try await download(TranslationSession.Configuration(source: from, target: to))
  }

  func translate(_ source: String, _ target: String, _ text: String) async throws -> String {
    guard #available(iOS 26.0, *) else { throw NEEDS_IOS_26_TRANSLATION }
    let key = "\(source)>\(target)"
    let session: TranslationSession
    if let kept = sessions[key] as? TranslationSession {
      session = kept
    } else {
      session = TranslationSession(
        installedSource: Locale.Language(identifier: source),
        target: Locale.Language(identifier: target)
      )
      sessions[key] = session
    }
    return try await session.translate(text).targetText
  }

  /** Frees what the sessions hold. */
  func close() {
    sessions.removeAll()
  }

  /**
   Downloads need a TranslationSession from a SwiftUI view on screen: iOS shows its own
   sheet from it, asking whether to download. The view is invisible and goes once done.
   */
  @available(iOS 26.0, *)
  private func download(_ configuration: TranslationSession.Configuration) async throws {
    #if canImport(UIKit) && !targetEnvironment(macCatalyst)
    guard let host = Self.topViewController() else {
      throw OnDeviceError("The app is not ready to download the translation.")
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      var hosting: UIViewController?
      let view = TranslationDownload(configuration: configuration) { error in
        if let hosting {
          hosting.willMove(toParent: nil)
          hosting.view.removeFromSuperview()
          hosting.removeFromParent()
        }
        hosting = nil
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      }
      let controller = UIHostingController(rootView: view)
      controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
      controller.view.backgroundColor = .clear
      controller.view.isUserInteractionEnabled = false
      host.addChild(controller)
      host.view.addSubview(controller.view)
      controller.didMove(toParent: host)
      hosting = controller
    }
    #else
    throw OnDeviceError("Translations are downloaded on an iPhone only.")
    #endif
  }

  #if canImport(UIKit)
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
  #endif
}

/** Has iOS download a language pair, then says how it went, once. */
@available(iOS 26.0, *)
struct TranslationDownload: View {
  let configuration: TranslationSession.Configuration
  let done: @MainActor (Error?) -> Void

  var body: some View {
    #if !targetEnvironment(macCatalyst)
    Color.clear.translationTask(configuration) { session in
      var failure: Error?
      do {
        try await session.prepareTranslation()
      } catch {
        failure = error
      }
      let error = failure
      await MainActor.run { done(error) }
    }
    #else
    Color.clear
    #endif
  }
}
