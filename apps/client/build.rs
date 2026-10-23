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
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&schema).expect("parsing schema.json");

    let mut settings = typify::TypeSpaceSettings::default();
    settings
        .with_struct_builder(false)
        .with_derive("PartialEq".into());
    let mut types = typify::TypeSpace::new(&settings);
    types
        .add_root_schema(schema)
        .expect("converting schema.json to Rust types");

    let file = syn::parse2::<syn::File>(types.to_stream()).expect("parsing generated types");
    // Zod marks objects closed, but a client must accept fields added by a newer server.
    let code = prettyplease::unparse(&file).replace("#[serde(deny_unknown_fields)]\n", "");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("api_types.rs");
    fs::write(out, code).unwrap();

    let config = slint_build::CompilerConfiguration::new().with_style("fluent-dark".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compiling Slint UI");
}
