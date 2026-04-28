use crate::fold::Frame;
use serde::Serialize;

#[derive(Serialize)]
pub struct RenderedEdge {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub kind: String,
}

#[derive(Serialize)]
pub struct RenderedFace {
    pub points: Vec<[f64; 2]>,
}

#[derive(Serialize, Default)]
pub struct EdgeCounts {
    pub m: usize,
    pub v: usize,
    pub b: usize,
    pub f: usize,
    pub u: usize,
}

#[derive(Serialize)]
pub struct RenderData {
    pub bounds: [f64; 4],
    pub edges: Vec<RenderedEdge>,
    pub faces: Vec<RenderedFace>,
    pub vertex_count: usize,
    pub edge_count: usize,
    pub face_count: usize,
    pub counts: EdgeCounts,
    pub title: Option<String>,
    pub author: Option<String>,
}

pub fn render(frame: &Frame) -> RenderData {
    let coord2 = |i: usize| -> Option<[f64; 2]> {
        let v = frame.vertices_coords.get(i)?;
        Some([*v.first()?, *v.get(1)?])
    };

    let mut edges = Vec::with_capacity(frame.edges_vertices.len());
    let mut counts = EdgeCounts::default();

    for (i, [a, b]) in frame.edges_vertices.iter().enumerate() {
        let (Some(pa), Some(pb)) = (coord2(*a), coord2(*b)) else { continue };

        let kind = frame
            .edges_assignment
            .get(i)
            .map(String::as_str)
            .unwrap_or("U")
            .to_string();

        match kind.as_str() {
            "M" => counts.m += 1,
            "V" => counts.v += 1,
            "B" => counts.b += 1,
            "F" => counts.f += 1,
            _ => counts.u += 1,
        }

        edges.push(RenderedEdge {
            x1: pa[0], y1: pa[1],
            x2: pb[0], y2: pb[1],
            kind,
        });
    }

    let mut faces = Vec::with_capacity(frame.faces_vertices.len());
    for face in &frame.faces_vertices {
        let points: Vec<[f64; 2]> = face.iter().filter_map(|&i| coord2(i)).collect();
        if points.len() >= 3 {
            faces.push(RenderedFace { points });
        }
    }

    RenderData {
        bounds: compute_bounds(frame),
        edges,
        faces,
        vertex_count: frame.vertices_coords.len(),
        edge_count: frame.edges_vertices.len(),
        face_count: frame.faces_vertices.len(),
        counts,
        title: frame.frame_title.clone(),
        author: frame.frame_author.clone(),
    }
}

fn compute_bounds(frame: &Frame) -> [f64; 4] {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for v in &frame.vertices_coords {
        if let (Some(&x), Some(&y)) = (v.first(), v.get(1)) {
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
    }

    if !min_x.is_finite() {
        return [0.0, 0.0, 1.0, 1.0];
    }

    [min_x, min_y, max_x, max_y]
}
