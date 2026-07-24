
use std::io;

use super::{Engine, EngineEvent};
use crate::terminal::{Mouse, MouseKind};
use crate::tree::PxRect;

impl Engine {
    pub fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> io::Result<usize> {
        if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "surface dimensions do not match its pixels",
            ));
        }
        crate::surfaces::set(surface, width, height, rgba);
        self.mark_surface_views(surface);
        Ok(rgba.len())
    }

    pub fn delete_surface(&mut self, surface: u32) -> io::Result<()> {
        crate::surfaces::remove(surface);
        self.mark_surface_views(surface);
        Ok(())
    }

    fn mark_surface_views(&mut self, surface: u32) {
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            if tree.uses_surface(surface) {
                tree.mark_paint();
            }
        }
    }

    pub(super) fn forward_pointer(
        &mut self,
        mouse: Mouse,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        if self.drag.is_some() {
            return false;
        }
        let target = match mouse.kind {
            MouseKind::Down => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1) else {
                    return false;
                };
                self.active_view = view;
                self.set_focus(view, None);
                self.key_passthrough = true;
                self.pointer_capture = Some((view, node));
                (view, node)
            }
            MouseKind::Move => match self.pointer_capture {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    self.update_hover_target(view, local, out);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            MouseKind::Up => match self.pointer_capture.take() {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            _ => return false,
        };
        let (view, node) = target;
        let local = self.comp.to_local(view, point);
        let rect = self.comp.views[view]
            .tree
            .rect(node)
            .unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Pointer {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            kind: mouse.kind,
            button: mouse.button,
            mods: mouse.mods,
            x: local.0 - rect.x,
            y: local.1 - rect.y,
        });
        true
    }
}
