//! Embed Discord's own icon (from the local Discord install) as resource 1,
//! so the host looks like Discord in the taskbar and Alt+Tab. The icon isn't
//! committed to the repo; if Discord isn't installed the exe just has no icon.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
    let ico = PathBuf::from(local).join("Discord").join("app.ico");
    if !ico.exists() {
        println!("cargo:warning=Discord icon not found at {}; building without an icon", ico.display());
        return;
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let copied = out.join("discord.ico");
    std::fs::copy(&ico, &copied).expect("copy icon");
    let rc = out.join("app.rc");
    std::fs::write(&rc, "1 ICON \"discord.ico\"\n").expect("write rc");
    embed_resource::compile(&rc, embed_resource::NONE);
}
