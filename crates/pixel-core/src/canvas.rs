pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
        }
    }

    /// Doubling memcpy fill: per-pixel loops are milliseconds at dev
    /// opt-level 0 on full-window canvases, memcpy is fast at any opt level.
    pub fn fill(&mut self, color: [u8; 4]) {
        if self.pixels.is_empty() {
            return;
        }
        self.pixels[..4].copy_from_slice(&color);
        let mut filled = 4;
        while filled < self.pixels.len() {
            let (done, rest) = self.pixels.split_at_mut(filled);
            let n = done.len().min(rest.len());
            rest[..n].copy_from_slice(&done[..n]);
            filled += n;
        }
    }

    pub fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
        let x1 = x.min(self.width);
        let y1 = y.min(self.height);
        let x2 = x.saturating_add(w).min(self.width);
        let y2 = y.saturating_add(h).min(self.height);
        for row in y1..y2 {
            for col in x1..x2 {
                let i = ((row * self.width + col) * 4) as usize;
                self.pixels[i..i + 4].copy_from_slice(&color);
            }
        }
    }

    pub fn draw_text(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
    ) {
        let mut pen_x = x as f32;
        for ch in text.chars() {
            let (metrics, coverage) = font.rasterize(ch, px);
            let glyph_x = pen_x.round() as i32 + metrics.xmin;
            // ymin is the bottom edge's offset from the baseline (positive = up),
            // so the bitmap's top row sits at baseline - height - ymin.
            let glyph_y = baseline - metrics.height as i32 - metrics.ymin;
            self.blend_mask(
                glyph_x,
                glyph_y,
                metrics.width,
                metrics.height,
                &coverage,
                color,
            );
            pen_x += metrics.advance_width;
        }
    }

    fn blend_mask(&mut self, x: i32, y: i32, w: usize, h: usize, mask: &[u8], color: [u8; 4]) {
        for row in 0..h {
            let py = y + row as i32;
            if py < 0 || py >= self.height as i32 {
                continue;
            }
            for col in 0..w {
                let px = x + col as i32;
                if px < 0 || px >= self.width as i32 {
                    continue;
                }
                let coverage = u32::from(mask[row * w + col]);
                if coverage == 0 {
                    continue;
                }
                let i = ((py as u32 * self.width + px as u32) * 4) as usize;
                for (dst, &src) in self.pixels[i..i + 4].iter_mut().zip(&color) {
                    *dst = ((u32::from(*dst) * (255 - coverage) + u32::from(src) * coverage) / 255)
                        as u8;
                }
            }
        }
    }
}

impl Canvas {
    pub fn fill_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: f32,
        color: [u8; 4],
    ) {
        if let Some(path) = rounded_rect_path(x, y, w, h, radius) {
            self.paint_path(&path, color, None);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stroke_rounded_rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        radius: f32,
        width: f32,
        color: [u8; 4],
    ) {
        // Inset by half the stroke so the border stays inside the box like CSS.
        let inset = width / 2.0;
        if let Some(path) = rounded_rect_path(
            x + inset,
            y + inset,
            w - width,
            h - width,
            (radius - inset).max(0.0),
        ) {
            self.paint_path(&path, color, Some(width));
        }
    }

    fn paint_path(&mut self, path: &tiny_skia::Path, color: [u8; 4], stroke_width: Option<f32>) {
        let Some(mut pixmap) =
            tiny_skia::PixmapMut::from_bytes(&mut self.pixels, self.width, self.height)
        else {
            return;
        };
        let mut paint = tiny_skia::Paint::default();
        paint.set_color_rgba8(color[0], color[1], color[2], color[3]);
        paint.anti_alias = true;
        match stroke_width {
            None => pixmap.fill_path(
                path,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            ),
            Some(width) => pixmap.stroke_path(
                path,
                &paint,
                &tiny_skia::Stroke {
                    width,
                    ..tiny_skia::Stroke::default()
                },
                tiny_skia::Transform::identity(),
                None,
            ),
        }
    }
}

fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = radius.min(w / 2.0).min(h / 2.0);
    if r < 0.5 {
        return Some(tiny_skia::PathBuilder::from_rect(
            tiny_skia::Rect::from_xywh(x, y, w, h)?,
        ));
    }
    /**
     * im surprised tiny skia doesn't handle this, but i guess tiny skia is just
     * moving a line around? oh it lets u draw cubic lines i guess
     */
    // Quarter circles as cubic beziers; K is the standard circle approximation.
    const K: f32 = 0.552_284_8;
    let k = r * (1.0 - K);
    let mut pb = tiny_skia::PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - k, y, x + w, y + k, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + k, y + h, x, y + h - k, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + k, x + k, y, x + r, y);
    pb.close();
    pb.finish()
}

pub fn measure_text(font: &fontdue::Font, text: &str, px: f32) -> f32 {
    text.chars()
        .map(|ch| font.metrics(ch, px).advance_width)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_rect_clamps_to_bounds() {
        let mut canvas = Canvas::new(4, 4);
        canvas.fill_rect(2, 2, 100, 100, [1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[((3 * 4 + 3) * 4) as usize..], &[1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn blend_mask_full_coverage_replaces_half_blends() {
        let mut canvas = Canvas::new(2, 1);
        canvas.fill([0, 0, 0, 255]);
        canvas.blend_mask(0, 0, 2, 1, &[255, 128], [200, 100, 50, 255]);
        assert_eq!(&canvas.pixels[0..4], &[200, 100, 50, 255]);
        let half = &canvas.pixels[4..8];
        assert_eq!(half[0], (200 * 128 / 255) as u8);
        assert_eq!(half[3], 255);
    }

    #[test]
    fn blend_mask_clips_out_of_bounds_positions() {
        let mut canvas = Canvas::new(2, 2);
        canvas.blend_mask(-1, -1, 3, 3, &[255; 9], [10, 20, 30, 255]);
        assert_eq!(&canvas.pixels[0..4], &[10, 20, 30, 255]);
    }
}
