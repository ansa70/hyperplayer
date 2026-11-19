//! Generates Rust types from the Zod-derived JSON Schema (`api/schema.json`)
//! and compiles the Slint UI. Run `vp run @hyperplayer/schemas#generate`
//! after changing the schemas; cargo rebuilds when the schema file changes.

use std::{env, fs, path::Path};

fn main() {
    let schema_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../api/schema.json");
    println!("cargo:rerun-if-changed={}", schema_path.display());

    let schema = fs::read_to_string(&schema_path).unwrap_or_else(|e| {
        panic!(
            "reading {}: {e} (run the schemas#generate task)",
            schema_path.display()
        )
    });
    let mut schema: serde_json::Value = serde_json::from_str(&schema).expect("parsing schema.json");
    optional_defaults(&mut schema);
    let schema: schemars::schema::RootSchema =
        serde_json::from_value(schema).expect("reading schema.json");

    let mut settings = typify::TypeSpaceSettings::default();
    settings
        .with_struct_builder(false)
        .with_derive("PartialEq".into());
    let mut types = typify::TypeSpace::new(&settings);
    types
        .add_root_schema(schema)
        .expect("converting schema.json to Rust types");

    let file = syn::parse2::<syn::File>(types.to_stream()).expect("parsing generated types");
    // Zod marks objects closed, but a client must accept fields added by a newer server;
    // and fields added since an older server: a nullable one it leaves out reads as null.
    let code = prettyplease::unparse(&file)
        .replace("#[serde(deny_unknown_fields)]\n", "")
        .replace(
            "deserialize_with = \"::std::option::Option::deserialize\"",
            "default, deserialize_with = \"::std::option::Option::deserialize\"",
        );
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("api_types.rs");
    fs::write(out, code).unwrap();

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        windows_resources();
    }

    let translations = Path::new(env!("CARGO_MANIFEST_DIR")).join("translations");
    rust_translations(&translations);

    // One catalog for the whole UI (no per-component contexts), shared with the Rust side.
    let config = slint_build::CompilerConfiguration::new()
        .with_style("fluent-dark".into())
        .with_bundled_translations(&translations)
        .with_default_translation_context(slint_build::DefaultTranslationContext::None);
    slint_build::compile_with_config("ui/app.slint", config).expect("compiling Slint UI");
}

/// The catalogs in `translations/<lang>/LC_MESSAGES/hyperplayer.po` as a Rust table, for
/// the text built in Rust (src/i18n.rs). Untranslated and fuzzy entries are left out.
fn rust_translations(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut languages: Vec<_> = fs::read_dir(dir)
        .expect("reading translations/")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("LC_MESSAGES/hyperplayer.po").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    languages.sort();
    let mut code = String::from("pub static CATALOGS: &[(&str, Entries)] = &[\n");
    for lang in languages {
        let po = dir.join(&lang).join("LC_MESSAGES/hyperplayer.po");
        println!("cargo:rerun-if-changed={}", po.display());
        let text =
            fs::read_to_string(&po).unwrap_or_else(|e| panic!("reading {}: {e}", po.display()));
        code += &format!("    ({lang:?}, &[\n");
        for (msgid, msgstrs) in parse_po(&text) {
            code += &format!("        ({msgid:?}, &{msgstrs:?}),\n");
        }
        code += "    ]),\n";
    }
    code += "];\n";
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("translations.rs"),
        code,
    )
    .unwrap();
}

/// (msgid, its translations: one, or one per plural form) for each translated entry.
fn parse_po(text: &str) -> Vec<(String, Vec<String>)> {
    let mut entries = Vec::new();
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let fuzzy = block
            .lines()
            .any(|l| l.starts_with("#,") && l.contains("fuzzy"));
        // Each keyword with its string, continuation lines ("…") joined to the one before.
        let mut fields: Vec<(&str, String)> = Vec::new();
        for line in block.lines().map(str::trim) {
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if line.starts_with('"') {
                if let Some((_, value)) = fields.last_mut() {
                    *value += &unquote(line);
                }
            } else if let Some((key, rest)) = line.split_once(' ') {
                fields.push((key, unquote(rest.trim())));
            }
        }
        let msgid = fields
            .iter()
            .find(|(k, _)| *k == "msgid")
            .map(|(_, v)| v.clone());
        let msgstrs: Vec<String> = fields
            .iter()
            .filter(|(k, _)| *k == "msgstr" || k.starts_with("msgstr["))
            .map(|(_, v)| v.clone())
            .collect();
        if let Some(id) = msgid
            && !id.is_empty()
            && !fuzzy
            && !msgstrs.is_empty()
            && msgstrs.iter().all(|s| !s.is_empty())
        {
            entries.push((id, msgstrs));
        }
    }
    entries
}

/// A .po string's text: without its quotes, escapes undone.
fn unquote(quoted: &str) -> String {
    let inner = quoted
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(quoted);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// An older server leaves out fields added since: a property with a default may be
/// missing (it then takes the default), so it isn't required.
fn optional_defaults(schema: &mut serde_json::Value) {
    match schema {
        serde_json::Value::Object(object) => {
            if let (
                Some(serde_json::Value::Object(properties)),
                Some(serde_json::Value::Array(required)),
            ) = (object.get("properties"), object.get("required"))
            {
                let kept: Vec<_> = required
                    .iter()
                    .filter(|name| {
                        name.as_str()
                            .and_then(|n| properties.get(n))
                            .is_none_or(|p| p.get("default").is_none())
                    })
                    .cloned()
                    .collect();
                object.insert("required".into(), kept.into());
            }
            object.values_mut().for_each(optional_defaults);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(optional_defaults),
        _ => {}
    }
}

/// The executable's icon (Explorer, taskbar, installer shortcuts) and version resource,
/// from packaging/windows/version.rc.
fn windows_resources() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let icon = dir.join("icons/hyperplayer.ico");
    let template = dir.join("../../packaging/windows/version.rc");
    println!("cargo:rerun-if-changed={}", icon.display());
    println!("cargo:rerun-if-changed={}", template.display());
    let version = fs::read_to_string(&template)
        .expect("reading version.rc")
        .replace("@VERSION@", env!("CARGO_PKG_VERSION"))
        .replace("@MAJOR@", env!("CARGO_PKG_VERSION_MAJOR"))
        .replace("@MINOR@", env!("CARGO_PKG_VERSION_MINOR"))
        .replace("@PATCH@", env!("CARGO_PKG_VERSION_PATCH"))
        .replace("@DESCRIPTION@", "HyperPlayer")
        .replace("@NAME@", "hyperplayer");
    let rc = Path::new(&env::var("OUT_DIR").unwrap()).join("hyperplayer.rc");
    let icon = icon.display().to_string().replace('\\', "/");
    fs::write(&rc, format!("1 ICON \"{icon}\"\n{version}")).unwrap();
    embed_resource::compile(&rc, embed_resource::NONE)
        .manifest_optional()
        .expect("compiling Windows resources");
}
