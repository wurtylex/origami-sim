mod fold;
mod fold3d;
mod geom;
mod render;

use fold::FoldFile;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct FoldDocument {
    file: FoldFile,
}

#[wasm_bindgen]
impl FoldDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<FoldDocument, JsError> {
        let file: FoldFile = serde_json::from_str(json).map_err(|e| JsError::new(&format!("Invalid FOLD file: {e}")))?;
        Ok(FoldDocument { file })
    }

    #[wasm_bindgen(getter)]
    pub fn title(&self) -> Option<String> {
        self.file.crease_pattern().frame_title.clone()
    }

    #[wasm_bindgen(getter, js_name = fileSpec)]
    pub fn file_spec(&self) -> Option<f64> {
        self.file.file_spec
    }

    #[wasm_bindgen(getter, js_name = hasFolded)]
    pub fn has_folded(&self) -> bool {
        self.file.folded_form().is_some()
    }

    #[wasm_bindgen(js_name = renderJson)]
    pub fn render_json(&self, mode: &str) -> Result<String, JsError> {
        let frame = match mode {
            "folded" => self
                .file
                .folded_form()
                .unwrap_or_else(|| self.file.crease_pattern()),
            _ => self.file.crease_pattern(),
        };
        to_json(&render::render(frame))
    }

    /// Compute 3D geometry
    #[wasm_bindgen(js_name = foldedGeometry)]
    pub fn folded_geometry(&self, t: f64) -> Result<String, JsError> {
        let geom = fold3d::fold(self.file.crease_pattern(), t);
        to_json(&geom)
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&e.to_string()))
}
