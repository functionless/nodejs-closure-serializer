{
  "targets": [
    {
      "target_name": "getInternalFields",
      "sources": [
         "native/addon.cc",
         "native/get-internal-fields.h",
         "native/get-internal-fields.cc",
       ],
      "include_dirs" : [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}