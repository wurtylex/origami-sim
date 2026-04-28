//! Physically-based origami folder using XPBD with sub-stepping.
//!
//! Bar-and-hinge model (Filipov et al. 2016) solved with XPBD (Macklin et al. 2016)

use crate::fold::Frame;
use crate::geom::Vec3;
use serde::Serialize;
use std::collections::HashMap;
use std::f64::consts::PI;

const DIST_COMPLIANCE: f64 = 1.0e-9;
const FACE_BEND_COMPLIANCE: f64 = 1.0e-6;
const CREASE_BEND_COMPLIANCE: f64 = 1.0e-6;
const DT: f64 = 1.0 / 60.0;
const SUB_STEPS: usize = 12;
const ITERATIONS_PER_SUBSTEP: usize = 20;
const OUTER_VELOCITY_DAMPING: f64 = 0.97;
const RAMP_STEPS: usize = 600;
const SETTLE_STEPS: usize = 150;

#[derive(Serialize)]
pub struct FoldedGeometry {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<u32>,
    pub edges: Vec<[u32; 2]>,
    pub edge_kinds: Vec<String>,
    pub bounds: [f64; 6],
    /// Mean axial strain at each vertex. 0 = no strain, 0.05 ≈ 5% stretched.
    pub vertex_strain: Vec<f64>,
}

pub struct Simulator {
    pub positions: Vec<Vec3>,
    pub velocities: Vec<Vec3>,
    pub inv_masses: Vec<f64>,
    pub distance_constraints: Vec<DistanceConstraint>,
    pub dihedral_constraints: Vec<DihedralConstraint>,
    pub current_t: f64,
}

pub struct DistanceConstraint {
    pub a: usize,
    pub b: usize,
    pub rest_length: f64,
    pub compliance: f64,
}

pub struct DihedralConstraint {
    pub a: usize, pub b: usize,
    pub c: usize, pub d: usize,
    pub target_angle: f64,
    pub is_crease: bool,
    pub compliance: f64,
}

impl Simulator {
    pub fn new(frame: &Frame) -> Self {
        let n_verts = frame.vertices_coords.len();

        let positions: Vec<Vec3> = frame
            .vertices_coords
            .iter()
            .map(|v| {
                let x = v.first().copied().unwrap_or(0.0);
                let y = v.get(1).copied().unwrap_or(0.0);
                Vec3::new(x, y, 0.0)
            })
            .collect();

        let mut triangles: Vec<[usize; 3]> = Vec::new();
        for face in &frame.faces_vertices {
            if face.len() < 3 { continue; }
            for i in 1..(face.len() - 1) {
                triangles.push([face[0], face[i], face[i + 1]]);
            }
        }

        let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };

        let mut edge_tris: HashMap<(usize, usize), Vec<(usize, usize)>> = HashMap::new();
        for (ti, t) in triangles.iter().enumerate() {
            for (a, b, apex) in [
                (t[0], t[1], t[2]),
                (t[1], t[2], t[0]),
                (t[2], t[0], t[1]),
            ] {
                edge_tris.entry(key(a, b)).or_default().push((ti, apex));
            }
        }

        let mut cp_edge: HashMap<(usize, usize), (String, f64)> = HashMap::new();
        for (i, [a, b]) in frame.edges_vertices.iter().enumerate() {
            let kind = frame
                .edges_assignment
                .get(i)
                .map(String::as_str)
                .unwrap_or("U")
                .to_string();
            let target = match frame.edges_fold_angle.get(i).and_then(|a| *a) {
                Some(deg) => deg.to_radians(),
                None => match kind.as_str() {
                    "M" => -PI,
                    "V" =>  PI,
                    _   =>  0.0,
                },
            };
            cp_edge.insert(key(*a, *b), (kind, target));
        }

        let mut distance_constraints = Vec::new();
        let mut dihedral_constraints = Vec::new();
        for (&(a, b), tris) in &edge_tris {
            let rest_length = (positions[a] - positions[b]).length();
            distance_constraints.push(DistanceConstraint {
                a, b, rest_length,
                compliance: DIST_COMPLIANCE,
            });

            if tris.len() == 2 {
                let (_, c) = tris[0];
                let (_, d) = tris[1];

                let (target, is_crease, compliance) = match cp_edge.get(&(a, b)) {
                    Some((kind, tgt)) if kind == "M" || kind == "V" => {
                        (*tgt, true, CREASE_BEND_COMPLIANCE)
                    }
                    _ => (0.0, false, FACE_BEND_COMPLIANCE),
                };

                dihedral_constraints.push(DihedralConstraint {
                    a, b, c, d,
                    target_angle: target,
                    is_crease,
                    compliance,
                });
            }
        }

        Simulator {
            positions,
            velocities: vec![Vec3::new(0.0, 0.0, 0.0); n_verts],
            inv_masses: vec![1.0; n_verts],
            distance_constraints,
            dihedral_constraints,
            current_t: 0.0,
        }
    }

    pub fn step(&mut self, t: f64, dt: f64) {
        self.current_t = t;
        let sub_dt = dt / SUB_STEPS as f64;

        for _ in 0..SUB_STEPS {
            self.sub_step(t, sub_dt);
        }

        self.apply_outer_damping();
        self.zero_mean_velocity();
    }

    fn sub_step(&mut self, t: f64, dt: f64) {
        let n = self.positions.len();
        let prev_positions = self.positions.clone();

        for i in 0..n {
            if self.inv_masses[i] == 0.0 { continue; }
            self.positions[i] = self.positions[i] + self.velocities[i] * dt;
        }

        let mut lambda_dist = vec![0.0; self.distance_constraints.len()];
        let mut lambda_dihedral = vec![0.0; self.dihedral_constraints.len()];

        for _ in 0..ITERATIONS_PER_SUBSTEP {
            for (i, c) in self.distance_constraints.iter().enumerate() {
                project_distance(
                    &mut self.positions, &self.inv_masses, c, dt, &mut lambda_dist[i],
                );
            }
            for (i, c) in self.dihedral_constraints.iter().enumerate() {
                let rest = if c.is_crease { c.target_angle * t } else { 0.0 };
                project_dihedral(
                    &mut self.positions, &self.inv_masses, c, rest, dt, &mut lambda_dihedral[i],
                );
            }
        }

        for i in 0..n {
            if self.inv_masses[i] == 0.0 {
                self.velocities[i] = Vec3::new(0.0, 0.0, 0.0);
                continue;
            }
            self.velocities[i] = (self.positions[i] - prev_positions[i]) / dt;
        }
    }

    fn apply_outer_damping(&mut self) {
        for v in &mut self.velocities {
            *v = *v * OUTER_VELOCITY_DAMPING;
        }
    }

    fn zero_mean_velocity(&mut self) {
        let mut sum = Vec3::new(0.0, 0.0, 0.0);
        let mut count = 0;
        for (i, v) in self.velocities.iter().enumerate() {
            if self.inv_masses[i] > 0.0 {
                sum = sum + *v;
                count += 1;
            }
        }
        if count == 0 { return; }
        let mean = sum / (count as f64);
        for (i, v) in self.velocities.iter_mut().enumerate() {
            if self.inv_masses[i] > 0.0 {
                *v = *v - mean;
            }
        }
    }

    /// Quasi-statically advance to `t_target`, then settle.
    pub fn solve_to(&mut self, t_target: f64) {
        let t0 = self.current_t;
        for k in 1..=RAMP_STEPS {
            let t = t0 + (t_target - t0) * (k as f64 / RAMP_STEPS as f64);
            self.step(t, DT);
        }
        for _ in 0..SETTLE_STEPS {
            self.step(t_target, DT);
        }
    }

    pub fn compute_vertex_strain(&self) -> Vec<f64> {
        let n = self.positions.len();
        let mut sum = vec![0.0; n];
        let mut count = vec![0usize; n];

        for c in &self.distance_constraints {
            if c.rest_length < 1e-12 { continue; }
            let len = (self.positions[c.a] - self.positions[c.b]).length();
            let strain = ((len - c.rest_length) / c.rest_length).abs();
            sum[c.a] += strain;
            sum[c.b] += strain;
            count[c.a] += 1;
            count[c.b] += 1;
        }

        sum.iter()
            .zip(count.iter())
            .map(|(s, c)| if *c > 0 { s / (*c as f64) } else { 0.0 })
            .collect()
    }
}

fn project_distance(
    pos: &mut [Vec3],
    inv_mass: &[f64],
    c: &DistanceConstraint,
    dt: f64,
    lambda: &mut f64,
) {
    let w_a = inv_mass[c.a];
    let w_b = inv_mass[c.b];
    let w_sum = w_a + w_b;
    if w_sum < 1e-12 { return; }

    let d = pos[c.a] - pos[c.b];
    let len = d.length();
    if len < 1e-12 { return; }
    let n = d / len;

    let constraint = len - c.rest_length;
    let alpha_tilde = c.compliance / (dt * dt);
    let denom = w_sum + alpha_tilde;
    let delta_lambda = -(constraint + alpha_tilde * *lambda) / denom;
    *lambda += delta_lambda;

    pos[c.a] = pos[c.a] + n * (delta_lambda * w_a);
    pos[c.b] = pos[c.b] - n * (delta_lambda * w_b);
}

fn project_dihedral(
    pos: &mut [Vec3],
    inv_mass: &[f64],
    c: &DihedralConstraint,
    rest: f64,
    dt: f64,
    lambda: &mut f64,
) {
    let pa = pos[c.a];
    let pb = pos[c.b];
    let pc = pos[c.c];
    let pd = pos[c.d];

    let e = pb - pa;
    let elen = e.length();
    if elen < 1e-9 { return; }
    let elen2 = elen * elen;
    let e_hat = e / elen;

    let n1_raw = (pb - pa).cross(pc - pa);
    let n2_raw = (pd - pa).cross(pb - pa);
    let a1_2 = n1_raw.length();
    let a2_2 = n2_raw.length();
    if a1_2 < 1e-9 || a2_2 < 1e-9 { return; }

    let n1 = n1_raw / a1_2;
    let n2 = n2_raw / a2_2;
    let h1 = a1_2 / elen;
    let h2 = a2_2 / elen;

    let cos_t = n1.dot(n2);
    let sin_t = n2.cross(n1).dot(e_hat);
    let theta = sin_t.atan2(cos_t);

    let mut constraint = theta - rest;
    while constraint >  PI { constraint -= 2.0 * PI; }
    while constraint < -PI { constraint += 2.0 * PI; }

    let f_c = (pc - pa).dot(e) / elen2;
    let f_d = (pd - pa).dot(e) / elen2;

    let grad_c = n1 / h1;
    let grad_d = n2 / h2;
    let grad_a = -(grad_c * (1.0 - f_c)) - (grad_d * (1.0 - f_d));
    let grad_b = -(grad_c * f_c) - (grad_d * f_d);

    let w_a = inv_mass[c.a];
    let w_b = inv_mass[c.b];
    let w_c = inv_mass[c.c];
    let w_d = inv_mass[c.d];

    let sum_w_grad2 =
        w_a * grad_a.dot(grad_a) +
        w_b * grad_b.dot(grad_b) +
        w_c * grad_c.dot(grad_c) +
        w_d * grad_d.dot(grad_d);

    if sum_w_grad2 < 1e-12 { return; }

    let alpha_tilde = c.compliance / (dt * dt);
    let denom = sum_w_grad2 + alpha_tilde;
    let delta_lambda = -(constraint + alpha_tilde * *lambda) / denom;
    *lambda += delta_lambda;

    pos[c.a] = pos[c.a] + grad_a * (delta_lambda * w_a);
    pos[c.b] = pos[c.b] + grad_b * (delta_lambda * w_b);
    pos[c.c] = pos[c.c] + grad_c * (delta_lambda * w_c);
    pos[c.d] = pos[c.d] + grad_d * (delta_lambda * w_d);
}

pub fn fold(frame: &Frame, t: f64) -> FoldedGeometry {
    let t = t.clamp(0.0, 1.0);
    let mut sim = Simulator::new(frame);

    if frame.faces_vertices.is_empty() {
        return assemble(frame, &sim);
    }

    sim.solve_to(t);
    assemble(frame, &sim)
}

fn assemble(frame: &Frame, sim: &Simulator) -> FoldedGeometry {
    let positions = &sim.positions;

    let mut triangles = Vec::new();
    for face in &frame.faces_vertices {
        if face.len() < 3 { continue; }
        for i in 1..(face.len() - 1) {
            triangles.push(face[0] as u32);
            triangles.push(face[i] as u32);
            triangles.push(face[i + 1] as u32);
        }
    }

    let mut edges = Vec::with_capacity(frame.edges_vertices.len());
    let mut edge_kinds = Vec::with_capacity(frame.edges_vertices.len());
    for (i, [a, b]) in frame.edges_vertices.iter().enumerate() {
        edges.push([*a as u32, *b as u32]);
        let kind = frame
            .edges_assignment
            .get(i)
            .map(String::as_str)
            .unwrap_or("U")
            .to_string();
        edge_kinds.push(kind);
    }

    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for v in positions {
        for (k, c) in [v.x, v.y, v.z].iter().enumerate() {
            lo[k] = lo[k].min(*c);
            hi[k] = hi[k].max(*c);
        }
    }
    if !lo[0].is_finite() {
        lo = [0.0; 3];
        hi = [1.0; 3];
    }

    let vertices: Vec<[f64; 3]> = positions.iter().map(|p| [p.x, p.y, p.z]).collect();
    let vertex_strain = sim.compute_vertex_strain();

    FoldedGeometry {
        vertices,
        triangles,
        edges,
        edge_kinds,
        bounds: [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]],
        vertex_strain,
    }
}
