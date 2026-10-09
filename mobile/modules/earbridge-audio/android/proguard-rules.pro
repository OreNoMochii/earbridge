# sherpa-onnx's native code finds its Kotlin classes and their fields by name.
-keep class com.k2fsa.sherpa.onnx.** { *; }
# So does ONNX Runtime's, for its Java API.
-keep class ai.onnxruntime.** { *; }
