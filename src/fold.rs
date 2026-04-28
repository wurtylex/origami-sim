// FOLD file format types. Spec: https://github.com/edemaine/fold/blob/main/doc/spec.md

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Frame {
    #[serde(default)] pub frame_title: Option<String>,
    #[serde(default)] pub frame_author: Option<String>,
    #[serde(default)] pub frame_classes: Vec<String>,
    #[serde(default)] pub frame_attributes: Vec<String>,
    /// `[x, y]` or `[x, y, z]`.
    #[serde(default)] pub vertices_coords: Vec<Vec<f64>>,
    #[serde(default)] pub edges_vertices: Vec<[usize; 2]>,
    /// `"M"` mountain, `"V"` valley, `"B"` border, `"F"` flat,
    /// `"U"` unassigned, `"J"` join, `"C"` cut.
    #[serde(default)] pub edges_assignment: Vec<String>,
    /// Target dihedral angle in degrees. Folder falls back to ±180°
    /// from M/V assignment when absent.
    #[serde(default, rename = "edges_foldAngle")]
    pub edges_fold_angle: Vec<Option<f64>>,
    #[serde(default)] pub faces_vertices: Vec<Vec<usize>>,
}

impl Frame {
    fn has_class(&self, class: &str) -> bool {
        self.frame_classes.iter().any(|c| c == class)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FoldFile {
    #[serde(default)] pub file_spec: Option<f64>,
    #[serde(default)] pub file_creator: Option<String>,
    #[serde(default)] pub file_author: Option<String>,
    // Flattened: this frame's fields sit at the JSON root, not nested.
    #[serde(flatten)] pub top: Frame,
    #[serde(default)] pub file_frames: Vec<Frame>,
}

impl FoldFile {
    // Falls back to the top frame when nothing is explicitly classed.
    pub fn crease_pattern(&self) -> &Frame {
        if self.top.frame_classes.is_empty() || self.top.has_class("creasePattern") {
            return &self.top;
        }
        self.file_frames
            .iter()
            .find(|f| f.has_class("creasePattern"))
            .unwrap_or(&self.top)
    }

    pub fn folded_form(&self) -> Option<&Frame> {
        if self.top.has_class("foldedForm") {
            return Some(&self.top);
        }
        self.file_frames.iter().find(|f| f.has_class("foldedForm"))
    }
}
