{
  "targets": [
    {
      "target_name": "runtime-identity",
      "sources": ["identity.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "WarningLevel": 3,
              "TreatWarningAsError": 1
            }
          },
          "libraries": ["Advapi32.lib"]
        }],
        ["OS!='win'", {
          "cflags": ["-std=c11", "-Wall", "-Wextra", "-Werror"],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": ["-std=c11", "-Wall", "-Wextra", "-Werror"]
          }
        }]
      ]
    }
  ]
}
