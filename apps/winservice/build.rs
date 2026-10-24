//! The executable's version resource on Windows, from packaging/windows/version.rc.

use std::{env, fs, path::Path};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let template = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packaging/windows/version.rc");
    println!("cargo:rerun-if-changed={}", template.display());
    let rc = fs::read_to_string(&template)
        .expect("reading version.rc")
        .replace("@VERSION@", env!("CARGO_PKG_VERSION"))
        .replace("@MAJOR@", env!("CARGO_PKG_VERSION_MAJOR"))
        .replace("@MINOR@", env!("CARGO_PKG_VERSION_MINOR"))
        .replace("@PATCH@", env!("CARGO_PKG_VERSION_PATCH"))
        .replace("@DESCRIPTION@", "HyperPlayer service")
        .replace("@NAME@", "hyperplayer-service");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("hyperplayer-service.rc");
    fs::write(&out, rc).unwrap();
    embed_resource::compile(&out, embed_resource::NONE)
        .manifest_optional()
        .expect("compiling Windows resources");
}
