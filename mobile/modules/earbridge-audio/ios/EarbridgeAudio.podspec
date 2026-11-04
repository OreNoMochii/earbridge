Pod::Spec.new do |s|
  s.name           = 'EarbridgeAudio'
  s.version        = '1.0.0'
  s.summary        = "Alo's on-phone speech recognition and translation for iPhone"
  s.description    = "Apple's SpeechAnalyzer and Translation framework behind Alo's on-device engine (iOS 26 and newer)."
  s.license        = { type: 'Proprietary' }
  s.author         = 'EarBridge'
  s.homepage       = 'https://github.com/OreNoMochii/earbridge'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/OreNoMochii/earbridge.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks      = 'AVFoundation', 'Speech', 'SwiftUI'
  # Translation exists from iOS 17.4: weak, so the app still opens on older iPhones.
  s.weak_frameworks = 'Translation'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
