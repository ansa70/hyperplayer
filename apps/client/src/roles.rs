//! Credits as the server sends them (MusicBrainz's roles and instruments, or the files'
//! tags), and the years beside artists and band members, in the player's language. Text
//! not listed here stays as written.

use crate::{i18n, msg, tr};

/// The roles translated: every fixed one the server gives, and the usual instruments and
/// voices. Instruments are open-ended in MusicBrainz, so rarer ones stay in English.
pub const ROLES: &[&str] = &[
    msg!("performer"),
    msg!("conductor"),
    msg!("orchestra"),
    msg!("chorus master"),
    msg!("concertmaster"),
    msg!("programming"),
    msg!("composer"),
    msg!("lyricist"),
    msg!("writer"),
    msg!("librettist"),
    msg!("arranger"),
    msg!("vocal arranger"),
    msg!("orchestrator"),
    msg!("producer"),
    msg!("remixer"),
    msg!("engineer"),
    msg!("recording engineer"),
    msg!("mix engineer"),
    msg!("mastering engineer"),
    msg!("sound engineer"),
    msg!("audio engineer"),
    msg!("editor"),
    msg!("liner notes"),
    msg!("photography"),
    msg!("design"),
    msg!("art direction"),
    msg!("graphic design"),
    msg!("illustration"),
    msg!("mix"),
    msg!("DJ mix"),
    msg!("vocals"),
    msg!("instruments"),
    msg!("lead vocals"),
    msg!("background vocals"),
    msg!("choir vocals"),
    msg!("other vocals"),
    msg!("soprano vocals"),
    msg!("mezzo-soprano vocals"),
    msg!("alto vocals"),
    msg!("countertenor vocals"),
    msg!("tenor vocals"),
    msg!("baritone vocals"),
    msg!("bass vocals"),
    msg!("bass-baritone vocals"),
    msg!("vocal"),
    msg!("rap"),
    msg!("beatboxing"),
    msg!("whistling"),
    msg!("piano"),
    msg!("grand piano"),
    msg!("upright piano"),
    msg!("electric piano"),
    msg!("Rhodes piano"),
    msg!("Wurlitzer electric piano"),
    msg!("keyboard"),
    msg!("keyboards"),
    msg!("synthesizer"),
    msg!("Moog"),
    msg!("Minimoog"),
    msg!("Mellotron"),
    msg!("organ"),
    msg!("Hammond organ"),
    msg!("pipe organ"),
    msg!("harpsichord"),
    msg!("celesta"),
    msg!("clavinet"),
    msg!("accordion"),
    msg!("harmonium"),
    msg!("melodica"),
    msg!("sampler"),
    msg!("guitar"),
    msg!("electric guitar"),
    msg!("acoustic guitar"),
    msg!("classical guitar"),
    msg!("slide guitar"),
    msg!("steel guitar"),
    msg!("pedal steel guitar"),
    msg!("lap steel guitar"),
    msg!("twelve-string guitar"),
    msg!("resonator guitar"),
    msg!("guitar synthesizer"),
    msg!("bass"),
    msg!("bass guitar"),
    msg!("electric bass guitar"),
    msg!("acoustic bass guitar"),
    msg!("fretless bass"),
    msg!("double bass"),
    msg!("violin"),
    msg!("viola"),
    msg!("cello"),
    msg!("strings"),
    msg!("string section"),
    msg!("harp"),
    msg!("mandolin"),
    msg!("banjo"),
    msg!("ukulele"),
    msg!("sitar"),
    msg!("bouzouki"),
    msg!("lute"),
    msg!("dulcimer"),
    msg!("fiddle"),
    msg!("drums"),
    msg!("drums (drum set)"),
    msg!("drum set"),
    msg!("drum machine"),
    msg!("percussion"),
    msg!("tambourine"),
    msg!("congas"),
    msg!("bongos"),
    msg!("timpani"),
    msg!("snare drum"),
    msg!("cymbal"),
    msg!("vibraphone"),
    msg!("marimba"),
    msg!("xylophone"),
    msg!("glockenspiel"),
    msg!("tubular bells"),
    msg!("cowbell"),
    msg!("shaker"),
    msg!("triangle"),
    msg!("castanets"),
    msg!("handclaps"),
    msg!("tabla"),
    msg!("djembe"),
    msg!("steelpan"),
    msg!("saxophone"),
    msg!("soprano saxophone"),
    msg!("alto saxophone"),
    msg!("tenor saxophone"),
    msg!("baritone saxophone"),
    msg!("trumpet"),
    msg!("piccolo trumpet"),
    msg!("flugelhorn"),
    msg!("cornet"),
    msg!("trombone"),
    msg!("bass trombone"),
    msg!("French horn"),
    msg!("horn"),
    msg!("tuba"),
    msg!("euphonium"),
    msg!("brass"),
    msg!("clarinet"),
    msg!("bass clarinet"),
    msg!("flute"),
    msg!("alto flute"),
    msg!("piccolo"),
    msg!("recorder"),
    msg!("oboe"),
    msg!("English horn"),
    msg!("bassoon"),
    msg!("contrabassoon"),
    msg!("woodwind"),
    msg!("harmonica"),
    msg!("bagpipes"),
    msg!("pan flute"),
    msg!("turntables"),
    msg!("electronic instruments"),
    msg!("effects"),
    msg!("tape"),
    msg!("theremin"),
    msg!("sound effects"),
    msg!("loops"),
    msg!("samples"),
];

/// A role in the language in use: "guest tenor saxophone", "co-producer", "Piano"…
pub fn role(role: &str) -> String {
    type Qualify = fn(String) -> String;
    let qualified: [(&str, Qualify); 7] = [
        ("guest ", |r| tr!("guest {}", r)),
        ("additional ", |r| tr!("additional {}", r)),
        ("solo ", |r| tr!("solo {}", r)),
        ("assistant ", |r| tr!("assistant {}", r)),
        ("associate ", |r| tr!("associate {}", r)),
        ("executive ", |r| tr!("executive {}", r)),
        ("co-", |r| tr!("co-{}", r)),
    ];
    for (prefix, with) in qualified {
        if let Some(rest) = role.strip_prefix(prefix) {
            return with(self::role(rest));
        }
    }
    // File tags may capitalise what MusicBrainz writes in lower case.
    i18n::translate(role)
        .or_else(|| i18n::translate(&role.to_lowercase()))
        .map_or_else(|| role.to_string(), str::to_string)
}

/// Roles as one line: "piano, guest vocals".
pub fn roles(roles: &[String]) -> String {
    roles.iter().map(|r| role(r)).collect::<Vec<_>>().join(", ")
}

/// The server's years ("1926–1991", "b. 1926", "1965–present") in the language in use.
pub fn years(years: &str) -> String {
    match years.strip_prefix("b. ") {
        Some(year) => tr!("b. {}", year),
        None => years.replace("present", tr!("present")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_years() {
        i18n::set_language("en");
        assert_eq!(role("guest tenor saxophone"), "guest tenor saxophone");
        i18n::set_language("it");
        assert_eq!(role("tenor saxophone"), "sassofono tenore");
        assert_eq!(role("guest tenor saxophone"), "sassofono tenore (ospite)");
        assert_eq!(role("co-producer"), "co-produttore");
        assert_eq!(role("Piano"), "pianoforte");
        assert_eq!(role("nose flute"), "nose flute");
        assert_eq!(years("1965–present"), "1965–oggi");
        assert_eq!(years("b. 1926"), "n. 1926");
        assert_eq!(years("1926–1991"), "1926–1991");
    }
}
