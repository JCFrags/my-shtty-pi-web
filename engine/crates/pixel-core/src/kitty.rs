use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

const KITTY_CHUNK_SIZE: usize = 4096;

// this looks like slop nonsense, verify its needed
pub(crate) fn kitty_query_shm(image_id: u32, name: &str) -> Vec<u8> {
    let payload = BASE64.encode(name);
    format!("\x1b_Gi={image_id},a=q,t=s,f=32,s=1,v=1;{payload}\x1b\\").into_bytes()
}

// i want to look into how we do this, and be very careful and abstract this well per terminal
// and make it very clear what we explicitly support/don't
pub(crate) fn kitty_transmit_shm(image_id: u32, width: u32, height: u32, name: &str) -> Vec<u8> {
    let payload = BASE64.encode(name);
    format!("\x1b_Ga=T,f=32,s={width},v={height},t=s,i={image_id},p=1,q=2,C=1;{payload}\x1b\\")
        .into_bytes()
}

pub fn kitty_transmit(image_id: u32, width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (width * height * 4) as usize);
    let compressed = crate::profiler::span("kitty.compress", || {
        miniz_oxide::deflate::compress_to_vec_zlib(rgba, 1)
    });
    let payload = crate::profiler::span("kitty.base64", || BASE64.encode(&compressed));
    let chunks: Vec<&[u8]> = payload.as_bytes().chunks(KITTY_CHUNK_SIZE).collect();
    let last = chunks.len() - 1;

    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let more = u8::from(i != last);
        out.extend_from_slice(b"\x1b_G");
        if i == 0 {
            // todo: verify this is needed
            // C=1: the cursor stays put after display, so a full-window image
            // can't push the cursor past the last row and force a scroll.
            out.extend_from_slice(
                format!("a=T,f=32,o=z,s={width},v={height},t=d,i={image_id},p=1,q=2,C=1,m={more}")
                    .as_bytes(),
            );
        } else {
            out.extend_from_slice(format!("m={more}").as_bytes());
        }
        out.push(b';');
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\x1b\\");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Canvas;

    #[test]
    fn transmit_emits_single_chunk_for_small_images() {
        let out = kitty_transmit(1, 1, 1, &[0xff, 0x00, 0x00, 0xff]);
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("\x1b_Ga=T,f=32,o=z,s=1,v=1,t=d,i=1,p=1,q=2,C=1,m=0;"));
        assert!(text.ends_with("\x1b\\"));

        let payload = text
            .split_once(';')
            .and_then(|(_, rest)| rest.strip_suffix("\x1b\\"))
            .unwrap();
        let decompressed =
            miniz_oxide::inflate::decompress_to_vec_zlib(&BASE64.decode(payload).unwrap()).unwrap();
        assert_eq!(decompressed, [0xff, 0x00, 0x00, 0xff]);
    }

    #[test]
    fn transmit_chunks_large_payloads() {
        let mut seed = 0x12345678u32;
        let pixels: Vec<u8> = (0..64 * 64 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        let out = kitty_transmit(1, 64, 64, &pixels);
        let text = String::from_utf8_lossy(&out);
        let opens = text.matches("\x1b_G").count();
        assert!(opens > 1, "expected multiple chunks, got {opens}");
        assert_eq!(text.matches("m=1").count(), opens - 1);
        assert_eq!(text.matches("m=0").count(), 1);
        assert!(text.ends_with("\x1b\\"));
    }

    #[test]
    fn transmit_compresses_flat_canvases_hard() {
        let mut canvas = Canvas::new(256, 256);
        canvas.fill([24, 24, 32, 255]);
        let out = kitty_transmit(1, canvas.width, canvas.height, &canvas.pixels);
        assert!(out.len() < 4096, "expected tiny output, got {}", out.len());
    }
}
