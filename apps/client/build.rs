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

    // The executable's icon on Windows.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=hyperplayer.rc");
        println!("cargo:rerun-if-changed=icons/hyperplayer.ico");
        embed_resource::compile("hyperplayer.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("compiling Windows resources");
    }

    let config = slint_build::CompilerConfiguration::new().with_style("fluent-dark".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compiling Slint UI");
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
