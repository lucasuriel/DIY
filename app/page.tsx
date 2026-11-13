"use client";

/**
 * DIY: single-file app (Next.js App Router, drop in as app/page.tsx)
 *
 *   npm i three lucide-react
 *   npm i -D @types/three
 *
 * Seven machines load real models. Put these files in public/models/:
 *   robot-arm-parts.glb     23 parts, each already placed where it sits in the finished arm
 *   robot-arm-complete.glb  the finished arm in one piece (blueprint ghost and final look)
 *   motorcycle.glb, prosthetic-arm.glb, tablet.glb, laptop.glb, printer-3d.glb, bioreactor.glb
 *     one-piece models: they stay whole and their parts are clickable hotspots
 *
 * Plain three.js only: no @react-three/fiber or @react-three/drei, so there
 * are no React/R3F version-pairing problems.
 *
 * Sections: 1) vehicle data  2) 3D scene  3) workspace UI  4) landing page
 * Esc closes the workspace. Tailwind v3.4+ is required (h-dvh).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import machinesData from "../data/machines.json";
import {
  ArrowLeft, ArrowRight, Bike, Bot, Car, Check, Cog, Hammer, Hand,
  Home, ChevronDown, ChevronUp, ChevronsLeft, ChevronsRight, Laptop, FlaskConical, Smartphone, Tablet, Layers, Menu, Minus, Move3d, PanelRight, Play, Plus, Printer, Wrench, X, BookOpen, Cpu, Settings, Crosshair, Pause, RotateCcw,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* 1. Vehicle data                                                    */
/* ------------------------------------------------------------------ */

type VehicleId = "car" | "moto" | "arm" | "prosthetic" | "house" | "phone" | "tablet" | "computer" | "printer" | "reactor";
type Vec3 = [number, number, number];

/** Primitive used to compose a part.
 *  box: size [w, h, d] · cyl: [radius, height, optional bottom radius] · tor: [radius, tube] · sph: [radius] */
interface Shape {
  kind: "box" | "cyl" | "tor" | "sph";
  pos: Vec3;
  size: number[];
  rot?: Vec3;
  scale?: Vec3;
  /** overrides the part colour (tyres, glass, wires...) */
  color?: string;
  /** extra offset this shape travels at 100% explode, so one part can fan out */
  ex?: Vec3;
}

interface Part {
  id: string;
  name: string;
  spec: string;
  /** Plain-English: what it does and why it matters */
  what: string;
  /** What happens when this part fails */
  failure: string;
  color: string;
  /** below 1 draws the part see-through (body shells, sockets) */
  opacity?: number;
  /** Assembled position */
  position: Vec3;
  /** Direction and distance the part travels at 100% explode */
  explode: Vec3;
  shapes: Shape[];
  step: { title: string; instruction: string };
  /** for machines loaded from a GLB: the node in the parts file that is this part */
  node?: string;
}

/** A machine built from real 3D models instead of primitives.
 *  parts: one GLB whose nodes are the parts, already placed in their assembled spots.
 *  complete: the finished machine as one mesh, used as the blueprint ghost and the final look. */
interface ModelSource {
  /** leave out for a one-piece model: it then stays whole and its parts become hotspots (see spots) */
  parts?: string;
  complete: string;
  /** model units to scene units */
  scale: number;
  /** one-piece models: where each part sits on the model, by part id: [x, y, z] in model units,
   *  plus an optional 4th number, the side to view it from in degrees (0 = front, 90 = its right, 180 = back) */
  spots?: Record<string, [number, number, number, number?]>;
}

/** Model sources and hotspot positions live in data/machines.json so they can be
 *  tuned without touching this file. See the _README key in there for the units. */
const MODELS = machinesData as unknown as Record<string, ModelSource>;

interface Vehicle {
  id: VehicleId;
  name: string;
  tagline: string;
  short: string;
  /** y of the floor grid */
  groundY: number;
  /** OrbitControls target */
  focus: Vec3;
  camera: Vec3;
  /** Parts are listed in assembly order */
  parts: Part[];
  model?: ModelSource;
}

const HALF_PI = Math.PI / 2;
const AX_X: Vec3 = [0, 0, HALF_PI]; // lays a cylinder along the x axis
const AX_Z: Vec3 = [HALF_PI, 0, 0]; // lays a cylinder along the z axis

const shape = (kind: Shape["kind"]) => (pos: Vec3, size: number[], o: Partial<Shape> = {}): Shape => ({ kind, pos, size, ...o });
const box = shape("box");
const cyl = shape("cyl");
const ring = shape("tor");
const ball = shape("sph");

/** tyre + rim + hub, axle along z */
const wheel = (x: number, y: number, z: number, r: number, w: number, ex?: Vec3): Shape[] => [
  cyl([x, y, z], [r, w], { rot: AX_Z, color: "#18181b", ex }),
  cyl([x, y, z], [r * 0.68, w + 0.02], { rot: AX_Z, color: "#d4d4d8", ex }),
  cyl([x, y, z], [r * 0.2, w + 0.06], { rot: AX_Z, color: "#71717a", ex }),
];
/** repeats a shape group at the four corners of a car */
const corners = (f: (x: number, sg: number) => Shape[]): Shape[] => [-1.45, 1.45].flatMap((x) => [1, -1].flatMap((sg) => f(x, sg)));

/** Compact way to write a part: the shapes, the explain-it text, then the assembly step. */
const part = (
  id: string, name: string, spec: string, color: string, explode: Vec3, shapes: Shape[],
  what: string, failure: string, title: string, instruction: string, opacity?: number,
): Part => ({ id, name, spec, what, failure, color, position: [0, 0, 0], explode, shapes, step: { title, instruction }, ...(opacity ? { opacity } : {}) });

/** A part that comes from a GLB file: its pose is baked into the file, so only the words and the explode direction live here. */
const mpart = (node: string, name: string, spec: string, explode: Vec3, what: string, failure: string, title: string, instruction: string): Part => ({
  id: node, node, name, spec, what, failure, color: "#94a3b8", position: [0, 0, 0], explode, shapes: [], step: { title, instruction },
});

const VEHICLES: Record<VehicleId, Vehicle> = {
  car: {
    id: "car",
    name: "The Automobile",
    tagline: "Powertrain to pavement",
    short: "Car",
    groundY: -0.9,
    focus: [0, 0, 0],
    camera: [5.2, 2.6, 8.2],
    parts: [
      {
        id: "chassis",
        name: "Chassis Frame",
        spec: "Ladder frame, high-strength steel",
        what: "The skeleton under the car. Everything else bolts to it, and it keeps the wheels lined up while carrying the weight of the engine, body and passengers.",
        failure: "A bent or rusted frame makes the car pull to one side and wear tires unevenly. A cracked rail can fold in a crash or under load.",
        color: "#71717a",
        position: [0, 0, 0],
        explode: [0, -0.7, 0],
        shapes: [
          box([0, -0.5, 0.55], [4.2, 0.12, 0.1]),
          box([0, -0.5, -0.55], [4.2, 0.12, 0.1]),
          ...[-1.9, -0.7, 0.4, 1.9].map((x) => box([x, -0.5, 0], [0.1, 0.1, 1.2])),
          box([0.3, -0.46, 0], [2.6, 0.03, 1.0], { color: "#3f3f46" }),
          cyl([-1.45, -0.5, 0], [0.04, 1.6], { rot: AX_Z, color: "#a1a1aa" }),
        ],
        step: {
          title: "Lay the frame on stands",
          instruction: "Set the frame level on stands and check the diagonals match. A twisted frame never drives straight.",
        },
      },
      {
        id: "block",
        name: "Engine Block",
        spec: "Inline-4, 2.0 L, cast aluminium",
        what: "The main body of the engine. Its cylinders are where fuel burns, and passages inside carry coolant and oil around them. Everything else bolts to it, so it has to stay rigid and shed heat.",
        failure: "A cracked block or blown head gasket mixes coolant with oil or leaks it into the cylinders. The engine overheats, loses compression, and can seize within minutes.",
        color: "#71717a",
        position: [0, 0, 0],
        explode: [-0.5, 0.8, 0],
        opacity: 0.5,
        shapes: [
          box([-1.4, -0.2, 0], [1.0, 0.55, 0.62]),
          box([-1.4, 0.13, 0], [1.0, 0.14, 0.62], { color: "#52525b" }),
        ],
        step: {
          title: "Mount the block on the stand",
          instruction: "Set the block on the engine stand, wipe the bores clean, and oil them lightly. Everything stacks on this, so check it sits flat.",
        },
      },
      {
        id: "pistons",
        name: "Pistons",
        spec: "Forged aluminium, 86 mm bore, 4 pcs",
        what: "Burning fuel pushes each piston down. A rod links it to the crankshaft, which turns that straight push into rotation. Rings on the edge seal the gap against the cylinder wall.",
        failure: "Worn rings let combustion gas leak past, so you lose power and burn oil. A broken piston can wreck the cylinder wall and end the engine.",
        color: "#38bdf8",
        position: [0, 0, 0],
        explode: [-0.5, 1.9, 0],
        shapes: [-0.36, -0.12, 0.12, 0.36].map((dx) => cyl([-1.4 + dx, -0.2, 0], [0.1, 0.36])),
        step: {
          title: "Install pistons with rings staggered",
          instruction: "Stagger the ring gaps, squeeze the rings with a ring compressor, and tap each piston in with the arrow facing the front. Torque rod bolts to your engine's spec (commonly 40–50 N·m).",
        },
      },
      {
        id: "transmission",
        name: "Transmission",
        spec: "6-speed manual, 3.6:1 first gear",
        what: "Gears let the engine stay in its best rev range while the car crawls or cruises. Low gears multiply torque for pulling away. High gears keep revs down on the highway.",
        failure: "Worn synchros make shifts grind. A stripped gear tooth drops the car out of gear or locks the driveline.",
        color: "#3b82f6",
        position: [0, 0, 0],
        explode: [0, 1, 0],
        shapes: [
          cyl([-0.35, -0.25, 0], [0.2, 0.8], { rot: AX_X }),
          cyl([-0.8, -0.25, 0], [0.3, 0.3], { rot: AX_X, color: "#0891b2" }),
          cyl([0.75, -0.4, 0], [0.05, 1.4], { rot: AX_X, color: "#a1a1aa" }),
        ],
        step: {
          title: "Mate the transmission to the engine",
          instruction: "Slide the input shaft into the clutch plate, then tighten the bell housing bolts evenly in a cross pattern to spec.",
        },
      },
      {
        id: "differential",
        name: "Differential",
        spec: "Open differential, 3.9:1 final drive",
        what: "In a turn the outside wheel travels farther than the inside one. Spider gears inside the differential let the two wheels spin at different speeds while still sharing engine power.",
        failure: "A worn or dry differential whines and clunks. If the spider gears break, drive to the wheels is lost or the wheels bind in corners.",
        color: "#34d399",
        position: [0, 0, 0],
        explode: [0.7, -0.5, 0],
        shapes: [
          ball([1.45, -0.5, 0], [0.3], { scale: [1, 0.9, 1.1] }),
          ring([1.45, -0.5, 0], [0.34, 0.05], { rot: [0, HALF_PI, 0], color: "#38bdf8" }),
          cyl([1.45, -0.5, 0], [0.05, 1.6], { rot: AX_Z, color: "#a1a1aa" }),
        ],
        step: {
          title: "Set the differential in its carrier",
          instruction: "Seat the carrier bearings, set ring-and-pinion backlash (typically 0.1–0.2 mm), and torque the ring gear bolts evenly.",
        },
      },
      {
        id: "caliper",
        name: "Brake Caliper",
        spec: "Floating 2-piston caliper, 300 mm rotor",
        what: "The caliper squeezes brake pads against a spinning rotor. Friction turns your speed into heat, and hydraulic fluid multiplies the force from your foot.",
        failure: "A seized caliper drags or pulls the car to one side. Air or leaking fluid makes the pedal go soft and stopping distance grows fast.",
        color: "#eef3fb",
        position: [0, 0, 0],
        explode: [0, 0, 0],
        shapes: corners((x, sg) => [
          cyl([x, -0.5, 0.72 * sg], [0.26, 0.04], { rot: AX_Z, color: "#a1a1aa", ex: [0, 0, 0.9 * sg] }),
          box([x, -0.26, 0.72 * sg], [0.2, 0.2, 0.14], { color: "#ef4444", ex: [0, 0, 0.9 * sg] }),
        ]),
        step: {
          title: "Mount the caliper over the rotor",
          instruction: "Slide the caliper over the pads and rotor, torque the mounting bolts to spec, then bleed the line until the pedal feels firm.",
        },
      },
      {
        id: "wheels",
        name: "Wheels & Tires",
        spec: "17-inch alloy, 225/45 tires",
        what: "Four patches of rubber, each about the size of your hand, are all that touch the road. Tire grip decides how hard you can brake, turn and accelerate.",
        failure: "Low or worn tires lose grip, stretch braking distance and can blow out at speed. A loose wheel nut can let a wheel come off.",
        color: "#d4d4d8",
        position: [0, 0, 0],
        explode: [0, 0, 0],
        shapes: corners((x, sg) => wheel(x, -0.5, 0.95 * sg, 0.4, 0.3, [0, 0, 1.7 * sg])),
        step: {
          title: "Bolt on the wheels",
          instruction: "Fit each wheel over the studs and tighten the lug nuts in a star pattern to spec (commonly 100–120 N·m).",
        },
      },
      {
        id: "body",
        name: "Body Shell",
        spec: "Unibody steel panels (shown see-through)",
        what: "The outer shell keeps weather out and shapes the airflow. Its crumple zones soak up a crash before it reaches the cabin.",
        failure: "Rust or crash damage weakens the structure, and bent panels leave gaps that leak water and noise.",
        color: "#93c5fd",
        opacity: 0.26,
        position: [0, 0, 0],
        explode: [0, 2.4, 0],
        shapes: [
          box([0, -0.15, 0], [4.3, 0.5, 1.8]),
          box([-1.4, 0.15, 0], [1.6, 0.16, 1.7]),
          box([1.65, 0.15, 0], [1.1, 0.14, 1.7]),
          ball([0.35, 0.2, 0], [1], { scale: [1.25, 0.42, 0.85] }),
          box([-2.2, -0.25, 0], [0.12, 0.2, 1.7]),
          box([2.2, -0.25, 0], [0.12, 0.2, 1.7]),
          ...[1, -1].flatMap((sg) => [
            box([-2.16, -0.05, 0.6 * sg], [0.06, 0.12, 0.3], { color: "#fde68a" }),
            box([2.16, -0.05, 0.6 * sg], [0.06, 0.12, 0.3], { color: "#ef4444" }),
          ]),
        ],
        step: {
          title: "Lower the body onto the frame",
          instruction: "Lower the body onto its mounts, line up the bolt holes, and tighten the mounts evenly.",
        },
      },
    ],
  },

  moto: {
    id: "moto",
    name: "The Motorcycle",
    tagline: "Chassis, engine and balance",
    short: "Moto",
    groundY: -1.1,
    focus: [0, 0.1, 0],
    camera: [-2.4, 1.0, 4.0],
    model: MODELS.moto,
    parts: [
      {
        id: "frame",
        name: "Frame",
        spec: "Steel trellis, 3-point engine mounts",
        what: "The skeleton. It holds the engine, wheels and rider in exact positions, and it decides how stiff the bike feels in a corner.",
        failure: "A bent or cracked frame makes the bike wobble and track crooked. A weld failure at speed can be catastrophic, so a damaged frame gets replaced, not straightened.",
        color: "#71717a",
        position: [0, 0, 0],
        explode: [0, 0.8, 0],
        shapes: [
          ...[1, -1].flatMap((sg) => [
            box([-0.15, 0.55, 0.22 * sg], [2.0, 0.09, 0.09], { rot: [0, 0, -0.08] }),
            box([-0.7, 0, 0.22 * sg], [1.41, 0.08, 0.08], { rot: [0, 0, -0.785] }),
            box([1.05, -0.33, 0.3 * sg], [0.92, 0.07, 0.07], { rot: [0, 0, -0.165] }),
            box([1.1, 0.43, 0.18 * sg], [0.7, 0.07, 0.07], { rot: [0, 0, -0.395] }),
          ]),
          cyl([-1.2, 0.68, 0], [0.07, 0.5], { rot: [0, 0, -0.35] }),
          ball([-0.5, 0.82, 0], [0.5], { scale: [0.9, 0.45, 0.55], color: "#38bdf8" }),
          box([0.85, 0.68, 0], [0.9, 0.1, 0.34], { color: "#27272a" }),
        ],
        step: {
          title: "Stand the frame on the rear stand",
          instruction: "Check the frame is straight and the engine mounts are clean. Every other part bolts to this.",
        },
      },
      {
        id: "engine",
        name: "Inline-Four Engine",
        spec: "Inline-four, about 1,000 cc, liquid cooled",
        what: "Four cylinders sit side by side across the frame. Small, fast-moving pistons let it rev very high, which is where a sportbike makes its power. On many bikes the engine is also a structural part of the chassis.",
        failure: "Overheating warps the heads and drops compression. An oil-starved crank can seize and lock the rear wheel.",
        color: "#38bdf8",
        position: [0, 0, 0],
        explode: [0, -1.1, 0],
        shapes: [
          ball([0, -0.25, 0], [0.38], { scale: [1.15, 0.9, 0.9] }),
          cyl([-0.2, 0.15, 0], [0.2, 0.6], { rot: [0, 0, 0.6] }),
          cyl([0.2, 0.15, 0], [0.2, 0.6], { rot: [0, 0, -0.6] }),
          box([0.55, -0.3, 0], [0.55, 0.35, 0.45], { color: "#52525b" }),
        ],
        step: {
          title: "Lift the engine into the frame",
          instruction: "Raise it on a jack, line up the three mounting points, and tighten the bolts in order to spec (commonly 40–60 N·m).",
        },
      },
      {
        id: "chain",
        name: "Chain Drive",
        spec: "520 chain, 15/45 teeth, rear wheel",
        what: "A chain carries power from the front sprocket to the rear wheel. Tooth counts set the gearing: more rear teeth means stronger acceleration but a lower top speed.",
        failure: "A loose or dry chain wears out sprockets and can jump off. A snapped chain whips around and can crack the engine case or lock the wheel.",
        color: "#3b82f6",
        position: [0, 0, 0],
        explode: [1.4, -0.3, 0.7],
        shapes: [
          ...wheel(1.5, -0.4, 0, 0.5, 0.2),
          ring([1.5, -0.4, 0.2], [0.17, 0.025]),
          ring([0.75, -0.3, 0.2], [0.1, 0.025]),
          box([1.125, -0.215, 0.2], [0.75, 0.03, 0.04], { rot: [0, 0, -0.04] }),
          box([1.125, -0.485, 0.2], [0.77, 0.03, 0.04], { rot: [0, 0, -0.22] }),
        ],
        step: {
          title: "Fit sprockets, chain and rear wheel",
          instruction: "Join the chain with its master link, set slack to about 25–35 mm, and line up the rear wheel so both sides match.",
        },
      },
      {
        id: "fork",
        name: "Front Fork Suspension",
        spec: "43 mm telescopic, 120 mm travel",
        what: "Two tubes slide inside each other with a spring and oil inside. The spring soaks up bumps, the oil damping stops the bike bouncing, and the fork steers the front wheel.",
        failure: "Leaking seals lose damping, so the front dives and wobbles under braking. A bent tube makes steering feel loose and twitchy.",
        color: "#34d399",
        position: [0, 0, 0],
        explode: [-1.6, -0.3, 0],
        shapes: [
          cyl([-1.49, 0.19, 0.2], [0.05, 1.25], { rot: [0, 0, -0.35], color: "#a1a1aa" }),
          cyl([-1.49, 0.19, -0.2], [0.05, 1.25], { rot: [0, 0, -0.35], color: "#a1a1aa" }),
          box([-1.27, 0.78, 0], [0.15, 0.08, 0.55], { color: "#52525b" }),
          ...wheel(-1.7, -0.4, 0, 0.5, 0.2),
          cyl([-1.7, -0.4, 0.13], [0.26, 0.02], { rot: AX_Z, color: "#a1a1aa" }),
        ],
        step: {
          title: "Slide the fork through the triple clamps",
          instruction: "Set fork height, then tighten the clamp bolts evenly (commonly 20–25 N·m) so the tubes can't slip.",
        },
      },
      {
        id: "handlebar",
        name: "Handlebar Assembly",
        spec: "Aluminium 22 mm bar, cable throttle",
        what: "Your steering lever and control center: throttle, front brake and clutch. Small inputs here lean the bike over because of the front-end geometry.",
        failure: "A loose clamp lets the bar twist. A stuck throttle cable keeps the engine revving. Check both before every ride.",
        color: "#eef3fb",
        position: [0, 0, 0],
        explode: [-0.3, 1.3, 0],
        shapes: [
          cyl([-1.22, 0.95, 0], [0.025, 1.1], { rot: AX_Z }),
          ...[1, -1].flatMap((sg) => [
            cyl([-1.22, 0.95, 0.6 * sg], [0.04, 0.22], { rot: AX_Z, color: "#27272a" }),
            box([-1.3, 0.98, 0.45 * sg], [0.2, 0.03, 0.03]),
          ]),
          ball([-1.45, 0.7, 0], [0.17], { color: "#fde68a" }),
        ],
        step: {
          title: "Clamp on the handlebar",
          instruction: "Center the bar on the top clamp, set lever angles, and torque the clamp bolts evenly (commonly 20–25 N·m).",
        },
      },
    ],
  },

  arm: {
    id: "arm",
    name: "The Robotic Arm",
    short: "Arm",
    tagline: "Six axes, one industrial arm",
    groundY: -1.5,
    focus: [0, 0.3, 0],
    camera: [5.6, 2.4, 5.2],
    model: MODELS.arm,
    parts: [
      mpart("base-housing", "Base Casting (J1)", "Cast base, bolts to the floor", [0, 0, -0.35],
        "The heavy foot of the robot. It bolts to the floor and holds the big ring bearing the whole arm turns on. That turn is axis 1 (J1): it swings the arm left and right.",
        "Loose anchor bolts let the base rock when the arm moves fast, and every position after that drifts. A worn J1 bearing shows up as play when you push the arm sideways.",
        "Anchor the base casting", "Set the base on a level pad and bolt it down with every anchor. Check it is level before anything else goes on. Any error here grows at the tip of the arm."),
      mpart("servo-motor-a", "J1 Servo Motor", "AC servo with encoder, drives axis 1", [0.55, 0, -0.2],
        "This motor turns the whole arm around its base. An encoder on its back counts the motor's position thousands of times per turn, so the controller always knows where J1 is.",
        "A failing encoder or cable stops the robot with a position alarm. A worn brake can let the arm drift when the power is off.",
        "Mount the J1 servo", "Bolt the motor onto the base and mesh its pinion with the J1 gear. Plug in the power and encoder cables, but leave them unpowered."),
      mpart("junction-box", "Shoulder Casting", "Cast turret that turns on J1", [0, 0.15, -0.55],
        "The turret that sits on the base and spins with J1. It carries the shoulder joint (J2) and anchors the lower arm and the counterbalance.",
        "A cracked casting is rare but serious. More often, loose bolts between the turret and its bearing cause a knock every time the arm reverses.",
        "Seat the shoulder casting", "Lower the casting onto the J1 bearing, line up the dowel pins, and torque the ring bolts in a star pattern."),
      mpart("bearing-hub-a", "J2 Main Bearing", "Crossed-roller bearing at the shoulder", [0.35, 0, 0.25],
        "The big bearing at the shoulder. It lets the lower arm tilt forward and back while carrying the weight and twist of everything above it.",
        "A worn bearing lets the arm sag and wobble at the tip. Grinding or uneven resistance when you turn the joint by hand means it is failing.",
        "Press in the J2 main bearing", "Clean the bore, press the bearing in square, and fit its retaining ring. It must turn smoothly with no rough spots."),
      mpart("gearbox-b", "J2 Reducer", "Cycloidal reducer, high ratio", [0.6, 0, 0.25],
        "A compact gearbox that trades motor speed for force. The motor spins fast and weak, and the reducer turns that into the slow, huge torque needed to lift the arm.",
        "Worn teeth add backlash: the arm can move a little without the motor turning, so positioning gets sloppy. Leaking grease is the early warning.",
        "Fit the J2 reducer", "Slide the reducer onto the bearing, line up its bolt circle, and torque the bolts evenly. Fill it with grease to the mark."),
      mpart("gearbox-a", "J2 Servo Motor", "AC servo with brake, drives axis 2", [0.9, 0, 0.25],
        "Drives the shoulder. It works the hardest of all six motors, because it lifts the whole arm plus whatever the tool is holding.",
        "An overloaded J2 motor overheats and trips. If its brake fails, the arm can drop when the power is cut, which is why brakes are tested regularly.",
        "Mount the J2 servo", "Bolt the motor to the reducer input and check the shaft is fully seated. Connect the power, brake and encoder cables."),
      mpart("lower-link", "Lower Arm Link (J2)", "Cast link, shoulder to elbow", [-0.45, 0.1, 0.35],
        "The long arm that rises from the shoulder to the elbow. Tilting it forward and back is what reaches the tool out and pulls it in.",
        "Hits and overloads can crack the casting near the pivots. A bent link throws every position off, so it gets replaced, not straightened.",
        "Hang the lower arm", "Lift the link with a sling, line its lower eye up with the J2 output, and bolt it on. Keep it supported until the counterbalance is in."),
      mpart("pivot-pin-a", "Shoulder Pivot Pin", "Hardened steel pin at J2", [-0.75, 0, 0.2],
        "The pin in the bottom eye of the lower arm. It locates the link on the shoulder so it pivots on exactly the right axis.",
        "A worn pin or bushing makes a clunk when the arm changes direction.",
        "Fit the shoulder pivot pin", "Grease the pin and push it through the lower eye. Fit the retaining clip."),
      mpart("pivot-pin-b", "Elbow Pivot Pin", "Hardened steel pin at J3", [-0.75, 0.15, -0.2],
        "The pin in the top eye of the lower arm, where the upper arm will pivot. This is the elbow, axis 3.",
        "Wear here shows up as play at the tool, multiplied by the length of the upper arm.",
        "Fit the elbow pivot pin", "Grease the pin and push it through the top eye. Fit the retaining clip."),
      mpart("connecting-rod", "Counterbalance Link", "Spring balancer link", [-0.7, -0.1, -0.25],
        "A helper that pulls against gravity. It carries part of the arm's weight so the J2 motor does not have to hold it all the time.",
        "A weak or leaking balancer makes J2 work harder, run hot, and drift when the arm is stretched out.",
        "Connect the counterbalance", "Attach the link between the back of the shoulder casting and the lower arm. Pre-load it to the specified force before you remove the arm support."),
      mpart("pivot-pin-c", "Counterbalance Pin", "Steel pin at the balancer end", [-0.95, 0, 0.1],
        "The pin that joins the counterbalance link to the arm. It carries the full balancer load.",
        "A dry or worn pin squeaks and wears the hole in the link into an oval.",
        "Pin the counterbalance", "Grease and fit the pin, then the clip. Swing the arm by hand and check the balancer moves freely."),
      mpart("upper-arm", "Upper Arm (J3)", "Cast arm, elbow to wrist", [0, 0.55, 0],
        "The arm that pivots at the elbow and carries the wrist out to the work. Raising and lowering it is axis 3.",
        "Collisions bend or crack it. Because it is long, even a tiny angle error at the elbow becomes millimetres at the tool.",
        "Fit the upper arm", "Lift the upper arm onto the elbow pin, line it up, and bolt it to the J3 output. Keep it supported until the J3 motor and brake are in."),
      mpart("servo-motor-c", "J3 Servo Motor", "AC servo with brake, drives axis 3", [0.6, 0.1, -0.25],
        "Drives the elbow. Its brake holds the upper arm in place when the power is off.",
        "A worn brake lets the upper arm creep down after shutdown. Encoder faults stop the robot with an alarm.",
        "Mount the J3 servo", "Bolt the motor to the side of the elbow and connect it. Test the brake by releasing it with the arm supported."),
      mpart("servo-motor-b", "J4 Servo Motor", "AC servo, drives the wrist roll", [0, 0.5, -0.5],
        "Sits at the back of the upper arm and drives a shaft through it, so the whole wrist can roll (axis 4). Putting the motor at the back also balances the arm.",
        "A worn shaft coupling shows up as play when the wrist rolls.",
        "Mount the J4 servo", "Bolt the motor to the back of the upper arm and couple it to the drive shaft."),
      mpart("bearing-hub-b", "J4 Harmonic Drive", "Strain-wave gear, almost no backlash", [0, 0.75, 0.25],
        "A clever gear with a flexible ring that gets squeezed into an oval as it turns. It gives a big reduction in a tiny space with almost no play, which the wrist needs to be precise.",
        "The flexible ring eventually fatigues and cracks. Old grease speeds this up, and it shows as rising vibration.",
        "Install the J4 harmonic drive", "Slide the harmonic drive into the front of the upper arm and couple it to the J4 shaft. Grease it to spec."),
      mpart("bearing-hub-c", "J4 Bearing", "Angular contact bearing", [0, 0.95, 0.4],
        "Supports the wrist as it rolls, taking the push and twist that come back from the tool.",
        "A worn bearing lets the wrist wobble, which ruins precise work like welding or glue dispensing.",
        "Fit the J4 bearing", "Press the bearing onto the wrist output and secure it with its lock nut."),
      mpart("wrist-bracket", "Wrist Housing (J4)", "Cast housing that rolls on J4", [0, 0.35, 0.55],
        "The housing that rolls on axis 4 and holds the last two joints close to the tool.",
        "When its seals fail, coolant and dust get into the wrist gears.",
        "Mount the wrist housing", "Bolt the housing to the J4 output and fit its seals."),
      mpart("wrist-motor-block", "Wrist Unit (J5)", "Bends the tool up and down", [0, 0.3, 0.85],
        "Bends the tool up and down (axis 5). Together with J4 and J6, it lets the tool point in any direction, just like your wrist.",
        "Hard knocks to the tool damage J5 first, because it is the nearest joint with a lot of leverage on it.",
        "Fit the wrist unit", "Mount the J5 unit in the wrist housing and connect its drive."),
      mpart("end-cap", "J5 Bearing Cap", "Seals and preloads the J5 bearing", [0.5, 0.3, 0.85],
        "Closes the side of the J5 joint, holding the bearing in place and keeping the grease in.",
        "A loose cap lets the bearing lose its preload, and the tool starts to rattle.",
        "Close the J5 bearing", "Fit the cap with a new seal and torque its screws evenly."),
      mpart("wrist-reducer", "J6 Gearset / Tool Flange", "Last axis, standard tool flange", [0, -0.1, 1.05],
        "The last axis spins the tool itself (axis 6). The flange on the end has a standard bolt pattern where grippers, welding torches or suction cups attach.",
        "A tool that is too heavy or sits off-center wears the J6 gears fast. Always stay inside the rated payload.",
        "Fit the J6 gearset and flange", "Mount the gearset on the wrist, then the tool flange. Check it turns freely through its full range."),
      mpart("control-board-a", "Servo Driver Board", "Amplifier for the six motors", [-0.3, 0.15, -0.55],
        "Turns the controller's commands into the high currents that drive each motor. On big robots it lives in a separate cabinet beside the arm.",
        "Overheating or a failed power transistor stops the robot with a servo alarm, so the cabinet fans and filters must stay clean.",
        "Install the servo driver board", "Slide the board into the controller cabinet and connect its power and motor outputs."),
      mpart("control-board-b", "Controller Board", "Main CPU and motion planning", [0.3, 0.15, -0.55],
        "The brain. It runs your program, works out every joint angle many times a second (inverse kinematics), and watches the safety circuits.",
        "If its memory or backup battery is lost, the robot can forget where its joints are and has to be re-calibrated.",
        "Install the controller board", "Fit the main board in the cabinet and connect the teach pendant and the safety circuits."),
      mpart("cable-harness", "Cable Harness", "Motor, encoder and brake cables", [0, 0, -0.45],
        "Carries power and signals between the cabinet and all six motors. Inside the arm, the cables flex every time a joint moves.",
        "Cables that rub or twist too much crack inside and cause on-and-off faults that are hard to find, so harnesses are replaced on a schedule.",
        "Route the cable harness", "Run the harness from the cabinet to the base, then up through the arm. Clamp it at every bracket so it only bends where it was designed to. Power up and test each axis slowly."),
    ],
  },
  prosthetic: {
    id: "prosthetic",
    name: "The Prosthetic",
    short: "Prosthetic",
    tagline: "A cable-driven hand with muscle control",
    groundY: -1.1,
    focus: [0, 0.6, 0],
    camera: [1.8, 1.2, 5.2],
    model: MODELS.prosthetic,
    parts: [
      mpart("model_part2", "Socket", "Thermoformed shell, silicone liner", [0, -1.4, 0],
        "The custom cup the residual limb slides into. It spreads the load across the whole limb instead of one pressure point, and it is the only part made individually for one person.",
        "A bad fit causes sores and pain. A loose socket lets the whole arm rock, so the hand ends up somewhere other than where the wearer aimed it.",
        "Fit the socket to the limb", "Check the fit with the liner on. There should be firm contact all round and no hot spots. This is the part that gets remade as a limb changes shape."),
      mpart("model_part1", "Forearm Shell", "Moulded shell over the drive and battery", [1.4, 0, 0],
        "The body of the arm. It carries the motor that drives the fingers, the battery and the control board, and takes the load between the socket and the hand.",
        "A cracked shell lets the internals move, which throws off the tendon tension. The port on the side is a common wear point, since it is plugged and unplugged every day.",
        "Close up the forearm", "Seat the drive and battery in the shell, route the tendons clear of moving parts, and close it without pinching a cable."),
      mpart("model_part0", "Hand", "Cable-driven fingers, one drive motor", [0, 1.6, 0],
        "Four fingers and a thumb, all pulled by braided lines from a single motor. One motor closing every finger together is what keeps the hand light enough to wear all day.",
        "Frayed line makes the grip weak; a snapped one leaves a finger dead. Fingertips take the most abuse and are made to be replaced.",
        "Fit the hand", "Connect the tendons to the drive spool, set them so the fingers start fully open, and check the thumb clears the index finger as it closes."),
      mpart("emg", "Muscle Sensor", "2-channel EMG band, 20-450 Hz", [-1.1, 0, 0],
        "Two electrodes held against the skin by a band, worn on the limb inside the socket. A muscle gives off a tiny electrical signal when it tenses, and these pick it up: tense one muscle and the hand closes, tense the other and it opens. No nerve surgery, no implant.",
        "Sweat, or a band that has shifted, adds noise and the hand opens or closes when the wearer did not ask it to. Electrodes wear out and get replaced; the skin under them needs a rest.",
        "Fit the sensor band", "Place the electrodes over the muscle bellies, snug but not tight, then test each signal with the hand off. Mark the position so it goes back the same way tomorrow."),
      mpart("battery", "Battery Pack", "Rechargeable pack, about a day per charge", [1.1, 0, 0],
        "A rechargeable pack on a lead that runs to the forearm. A day of ordinary use is roughly one charge, so most people swap or charge it overnight. It is deliberately outside the arm, where it can be replaced without opening anything.",
        "An ageing pack makes the hand slow and weak before it fails outright, usually mid-grip. A swollen pack is replaced immediately, as with any lithium cell.",
        "Connect the battery", "Charge it fully, plug the lead into the forearm port, and check the hand runs a full open and close at speed before relying on it."),
    ],
  },

  house: {
    id: "house",
    name: "The House",
    short: "House",
    tagline: "From slab to roof, wires and pipes",
    groundY: -1,
    focus: [0, 0.7, 0],
    camera: [6.5, 3.8, 9],
    parts: [
      {
        id: "foundation",
        name: "Foundation Slab",
        spec: "4 in. concrete slab, 3,000 psi",
        what: "The foundation spreads the weight of the whole house over the ground so it can't sink or tilt. Everything above rests on it.",
        failure: "Cracks and settling tilt walls and doors, and a bad slab lets water and cold in.",
        color: "#71717a",
        position: [0, 0, 0],
        explode: [0, -0.8, 0],
        shapes: [box([0, -0.875, 0], [4.4, 0.25, 3.4])],
        step: { title: "Pour and level the slab", instruction: "Compact the ground, lay gravel and a vapor barrier, then pour the concrete and screed it flat." },
      },
      {
        id: "joists",
        name: "Floor Joists",
        spec: "2x10 lumber, 16 in. spacing",
        what: "Joists are the beams the floor sits on. They carry the weight of people and furniture sideways to the walls, so spacing and span matter.",
        failure: "Undersized or notched joists sag, make the floor bounce, and can crack under heavy loads.",
        color: "#c08a4a",
        position: [0, 0, 0],
        explode: [0, 0.3, 0],
        shapes: [
          ...[-1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8].map((x) => box([x, -0.65, 0], [0.08, 0.2, 3.0])),
          ...[1, -1].map((sg) => box([0, -0.65, 1.46 * sg], [4.0, 0.2, 0.08])),
          box([0, -0.53, 0], [4.0, 0.04, 3.0], { color: "#a16207" }),
        ],
        step: { title: "Lay the floor joists", instruction: "Set joists on edge at 16 in. spacing, nail them to the rim boards, and add the subfloor on top." },
      },
      {
        id: "walls",
        name: "Wall Framing",
        spec: "2x4 studs, 16 in. on center",
        what: "Studs stand up like ribs and carry the roof's weight down to the floor. Plates at the top and bottom tie them together.",
        failure: "A missing or cut stud lets the wall bow or buckle under the roof's weight.",
        color: "#d6a35c",
        position: [0, 0, 0],
        explode: [0, 1, 0],
        shapes: [
          ...[1.5, -1.5].flatMap((z) => [
            ...Array.from({ length: 9 }, (_, i) => box([-2 + i * 0.5, 0.55, z], [0.07, 2.1, 0.07])),
            box([0, 1.62, z], [4.1, 0.07, 0.1], { color: "#b8863f" }),
            box([0, -0.46, z], [4.1, 0.07, 0.1], { color: "#b8863f" }),
          ]),
          ...[2, -2].flatMap((x) => [
            ...Array.from({ length: 6 }, (_, i) => box([x, 0.55, -1.25 + i * 0.5], [0.07, 2.1, 0.07])),
            box([x, 1.62, 0], [0.1, 0.07, 3.1], { color: "#b8863f" }),
            box([x, -0.46, 0], [0.1, 0.07, 3.1], { color: "#b8863f" }),
          ]),
        ],
        step: { title: "Frame and raise the walls", instruction: "Nail studs between the plates, square each wall, raise it, and brace it before starting the next." },
      },
      {
        id: "roof",
        name: "Roof Trusses",
        spec: "Pre-built wood trusses, 24 in. spacing",
        what: "Each truss is a triangle: the rafters push out and the bottom chord pulls them in, so the roof holds itself up with no walls inside.",
        failure: "A damaged chord or loose connector lets the roof spread and sag, and heavy snow can collapse it.",
        color: "#e0b070",
        position: [0, 0, 0],
        explode: [0, 2.2, 0],
        shapes: [
          ...[-1.4, -0.7, 0, 0.7, 1.4].flatMap((z) => [
            box([-1.075, 2.2, z], [2.37, 0.09, 0.06], { rot: [0, 0, 0.435] }),
            box([1.075, 2.2, z], [2.37, 0.09, 0.06], { rot: [0, 0, -0.435] }),
            box([0, 1.68, z], [4.3, 0.07, 0.06]),
          ]),
          box([0, 2.7, 0], [0.08, 0.08, 3.1], { color: "#b8863f" }),
        ],
        step: { title: "Set the roof trusses", instruction: "Lift each truss onto the wall plates, fasten it with hurricane ties, and brace it straight." },
      },
      {
        id: "electrical",
        name: "Electrical Routing",
        spec: "14 AWG wire on 15 A circuits",
        what: "Wires run through holes in the studs to outlets, lights and the breaker panel. Each circuit has a breaker that cuts power before the wire overheats.",
        failure: "Overloaded or loose connections heat up and can start a fire, and a missing ground leaves a shock risk.",
        color: "#f59e0b",
        position: [0, 0, 0],
        explode: [0, 0.5, 2.2],
        shapes: [
          box([-1.85, 0.45, -1.42], [0.3, 0.5, 0.08], { color: "#94a3b8" }),
          box([0, 0.45, 1.42], [3.4, 0.03, 0.03]),
          box([0, 1.55, 0], [0.03, 0.03, 2.8]),
          ...[-1.5, 0, 1.5].flatMap((x) => [
            box([x, 0.22, 1.42], [0.03, 0.45, 0.03]),
            box([x, 0, 1.42], [0.12, 0.16, 0.05], { color: "#eef3fb" }),
          ]),
          ball([0, 1.45, 0], [0.12], { color: "#fde68a" }),
        ],
        step: { title: "Run the wiring", instruction: "Drill the studs, pull the cable, mount the boxes, and connect everything to the panel last." },
      },
      {
        id: "plumbing",
        name: "Plumbing Loops",
        spec: "1/2 in. PEX supply, 3 in. drain, 60 psi",
        what: "Pressurized supply pipes push hot and cold water to the fixtures. Sloped drain pipes carry waste away by gravity, and a vent lets air in so the water flows.",
        failure: "A leak soaks the walls and grows mold, and a blocked vent or flat drain backs up.",
        color: "#3b82f6",
        position: [0, 0, 0],
        explode: [0, 0.5, -2.2],
        shapes: [
          cyl([0, -0.1, -1.38], [0.04, 3.6], { rot: AX_X }),
          cyl([0, 0.05, -1.38], [0.04, 3.6], { rot: AX_X, color: "#ef4444" }),
          cyl([1.5, 0.5, -1.3], [0.09, 2.3], { color: "#9ca3af" }),
          cyl([0.4, -0.4, -1.3], [0.07, 2.2], { rot: AX_X, color: "#9ca3af" }),
          cyl([1.5, 2.3, -1.3], [0.06, 1.5], { color: "#9ca3af" }),
          cyl([-1.6, 0.05, -1.1], [0.28, 0.9], { color: "#cbd5e1" }),
        ],
        step: { title: "Run the plumbing", instruction: "Run the supply lines, slope the drains about 1/4 in. per foot, and pressure-test before closing the walls." },
      },
    ],
  },
  phone: {
    id: "phone",
    name: "The Smartphone",
    tagline: "Four layers in a glass sandwich",
    short: "Phone",
    groundY: -1.3,
    focus: [0, 0, 0],
    camera: [3.2, 1.2, 5.5],
    parts: [
      part("frame", "Frame & Back Glass", "Aluminium midframe, glass back", "#71717a", [0, 0, -0.9],
        [
          box([0, 0, -0.07], [1.2, 2.4, 0.03], { color: "#27272a" }),
          box([0, 1.2, 0], [1.2, 0.05, 0.16]), box([0, -1.2, 0], [1.2, 0.05, 0.16]),
          box([-0.6, 0, 0], [0.05, 2.4, 0.16]), box([0.6, 0, 0], [0.05, 2.4, 0.16]),
          box([-0.28, 0.85, -0.12], [0.5, 0.5, 0.06], { color: "#18181b" }),
          cyl([-0.38, 0.95, -0.16], [0.1, 0.04], { rot: AX_Z, color: "#1e3a8a" }),
          cyl([-0.18, 0.75, -0.16], [0.1, 0.04], { rot: AX_Z, color: "#1e3a8a" }),
        ],
        "The structure everything else sits in. The rails give it strength and also act as the antenna, and the back glass allows wireless charging.",
        "A bent frame cracks the display, and a cracked back glass lets water and dust reach the board.",
        "Lay out the frame", "Place the frame face-up on a clean mat and check the rails for bends. Fit the camera module and seal strip before anything else goes in."),
      part("board", "Logic Board", "SoC + 8 GB RAM, 5 nm", "#38bdf8", [0, 0.6, 0.7],
        [
          box([0, 0.7, -0.02], [1.0, 0.8, 0.03], { color: "#065f46" }),
          box([-0.2, 0.8, 0.01], [0.34, 0.34, 0.03], { color: "#18181b" }),
          box([0.25, 0.55, 0.01], [0.25, 0.2, 0.025], { color: "#a1a1aa" }),
        ],
        "The brain. The main chip runs apps, graphics and the modem, with memory stacked right on top of it to keep signals short.",
        "A cracked solder joint or water damage makes the phone reboot, lose signal or not turn on at all.",
        "Seat the logic board", "Connect the camera and antenna cables first, then press the board into the frame and tighten the screws in order. Do not force any connector."),
      part("battery", "Battery", "Li-ion, 4,500 mAh, 3.85 V", "#3b82f6", [0, -0.6, 0.8],
        [
          box([0, -0.4, -0.02], [0.95, 1.2, 0.07]),
          box([0, -0.4, 0.02], [0.6, 0.3, 0.005], { color: "#e4e4e7" }),
        ],
        "A flat lithium cell that holds the energy. A small protection chip stops it overcharging or overheating.",
        "A swollen or punctured cell can overheat and catch fire. Stop using a puffy battery right away.",
        "Fit the battery", "Stick the battery in the lower frame with its adhesive pull tabs, then plug in the connector last. Never press or bend the cell."),
      part("display", "Display", "6.1 in. OLED, 2556×1179", "#93c5fd", [0, 0, 1.8],
        [
          box([0, 0, 0.09], [1.14, 2.34, 0.03], { color: "#0b1220" }),
          box([0, 0, 0.108], [1.04, 2.2, 0.004], { color: "#1e3a8a" }),
          cyl([0, 1.05, 0.112], [0.05, 0.004], { rot: AX_Z, color: "#000000" }),
        ],
        "Each OLED pixel makes its own light, so black pixels are simply off. A touch layer on top senses your finger.",
        "A cracked panel shows dead lines or ghost touches. Water behind it dims or stains the pixels for good.",
        "Close the display", "Connect the display and touch cables, press the panel into the adhesive, and clamp it flat while it cures."),
    ],
  },
  tablet: {
    id: "tablet",
    name: "The Tablet",
    tagline: "A big screen over a bigger battery",
    short: "Tablet",
    groundY: -1.6,
    focus: [0, 0, 0],
    camera: [1.8, 0.4, 4.6],
    model: MODELS.tablet,
    parts: [
      part("chassis", "Aluminium Chassis", "Unibody aluminium, 5.9 mm", "#a1a1aa", [0, 0, -0.9],
        [
          box([0, 0, -0.06], [3.2, 2.2, 0.03]),
          box([0, 1.1, 0], [3.2, 0.05, 0.14]), box([0, -1.1, 0], [3.2, 0.05, 0.14]),
          box([-1.6, 0, 0], [0.05, 2.2, 0.14]), box([1.6, 0, 0], [0.05, 2.2, 0.14]),
        ],
        "A single milled block of aluminium. It keeps the thin body stiff and also pulls heat away from the chip.",
        "Bending the body flexes the display and board, which causes cracks and light bleeding at the edges.",
        "Prepare the chassis", "Clean the chassis, check that it sits flat, and fit the speaker and antenna strips along the edges."),
      part("board", "Logic Board", "Tablet SoC, 8 GB RAM, Wi-Fi 6E", "#38bdf8", [0.4, 0.7, 0.7],
        [
          box([1.2, 0, -0.02], [0.7, 1.8, 0.03], { color: "#065f46" }),
          box([1.2, 0.5, 0.01], [0.4, 0.4, 0.03], { color: "#18181b" }),
          box([1.2, -0.4, 0.01], [0.3, 0.3, 0.025], { color: "#a1a1aa" }),
        ],
        "A small board does the work of a computer: the chip, memory, storage and radios. The rest of the tablet is mostly screen and battery.",
        "Overheating throttles the chip and makes the tablet slow. A failed storage chip makes it boot loop.",
        "Seat the logic board", "Fit the board at the side, connect the antenna and battery flex cables, and screw it down in the marked order."),
      part("battery", "Battery Cells", "2 pouch cells, 28.6 Wh", "#3b82f6", [0, -0.6, 0.8],
        [
          box([-0.95, 0, -0.02], [0.85, 1.7, 0.06]),
          box([-0.05, 0, -0.02], [0.85, 1.7, 0.06]),
        ],
        "Two flat cells take up most of the inside. Charge is shared between them by a small controller.",
        "Cells that swell push the display away from the frame. Weak cells make the tablet shut off at 30%.",
        "Install the cells", "Place both cells in the bays, press them onto their adhesive strips, and join the flex cable without bending it sharply."),
      part("display", "Display", "11 in. LCD, touch digitiser", "#93c5fd", [0, 0, 1.8],
        [
          box([0, 0, 0.09], [3.14, 2.14, 0.03], { color: "#0b1220" }),
          box([0, 0, 0.108], [2.9, 1.94, 0.004], { color: "#1e3a8a" }),
          cyl([0, 1.0, 0.112], [0.03, 0.004], { rot: AX_Z, color: "#27272a" }),
        ],
        "A backlit LCD with a touch layer fused on top. The front camera sits in the top bezel.",
        "Pressure on a cracked panel spreads the damage. Water between the layers leaves bright patches.",
        "Bond the display", "Test the touch response before sealing. Then press the panel onto the frame and clamp it evenly until the adhesive sets."),
    ],
  },
  computer: {
    id: "computer",
    name: "The Laptop",
    tagline: "A whole computer in a slim case",
    short: "Laptop",
    groundY: -1.0,
    focus: [0, 0.2, 0],
    camera: [1.8, 2.0, 4.6],
    model: MODELS.computer,
    parts: [
      mpart("display", "Display", "13 in. backlit panel, thin bezel", [0, 0, 0],
        "The screen is a sandwich of a backlight, a liquid-crystal layer and color filters. Each pixel is a tiny shutter that lets more or less light through. The lid also hides the webcam and the Wi-Fi antennas.",
        "Pressure on the closed lid cracks the panel and leaves black blotches or lines. A pinched display cable in the hinge makes the picture flicker when you move the lid.",
        "Fit the display", "Seat the panel in the lid, route its cable through the hinge, and clip the bezel on. Never press on the middle of the panel."),
      mpart("hinge", "Hinge", "Steel friction hinge, carries the cables", [0, 0, 0],
        "Two small friction hinges hold the lid at any angle and carry the display and antenna cables through to the base. They are tight enough to stop the lid falling, and loose enough to open with one hand.",
        "A hinge that seizes can tear its mounting posts out of the case. Loose hinges let the lid wobble and wear the cables that pass through them.",
        "Bolt the hinges", "Screw each hinge to the lid and then to the base. Route the cables through the hinge channel before tightening, so nothing gets pinched."),
      mpart("keyboard", "Keyboard", "Scissor switches, backlit", [0, 0, 0],
        "Under each key is a small scissor mechanism and a rubber dome. Pressing the key squashes the dome onto a membrane and closes a circuit. A controller scans the grid of keys many times a second to see which are down.",
        "Spilled liquid shorts the membrane, so keys stop working or type the wrong letter. Crumbs under a key block the scissor and make it stick.",
        "Install the keyboard", "Lay the keyboard into the top case, fasten it down, and connect its ribbon cable to the board."),
      mpart("trackpad", "Trackpad", "Glass surface, multi-touch", [0, 0, 0],
        "A grid of sensors under the glass feels the tiny electrical change your fingertips cause. Software turns those readings into pointer movement, taps and gestures.",
        "A swelling battery underneath pushes the trackpad up, so it stops clicking. That is a warning sign to stop using the laptop.",
        "Fit the trackpad", "Set the trackpad into the palm rest, adjust it so the gap is even all round, and connect its cable."),
      mpart("board", "Logic Board & Processor", "CPU, memory and SSD on one board", [0, 0, 0],
        "The main board carries the processor, memory and storage. In thin laptops these are soldered on to save space, which keeps the laptop slim but makes it harder to upgrade.",
        "Heat and flexing can crack tiny solder joints and cause random crashes. Liquid that reaches the board corrodes it within days.",
        "Seat the logic board", "Lower the board into the base, connect the display, keyboard and trackpad cables, and screw it down. Connect the battery last."),
      mpart("cooling", "Cooling System", "Heat pipe, fins and fan", [0, 0, 0],
        "A copper heat pipe carries heat from the processor to a stack of thin fins. A fan blows air through the fins and out of the vents. Without it, the chip would overheat in seconds.",
        "Dust clogs the fins, so the fan runs loud and the laptop slows itself down to stay cool. Dried-out thermal paste has the same effect.",
        "Mount the cooler", "Put fresh thermal paste on the processor, set the heat pipe on top, and tighten its screws in the numbered order so the pressure is even."),
      mpart("battery", "Battery", "Lithium-ion cells under the palm rest", [0, 0, 0],
        "Several flat lithium cells sit under the palm rest. A small circuit balances them and stops them over-charging or running too low.",
        "Old cells hold less charge and can swell. A puffy battery lifts the trackpad or bends the case, and it must be replaced right away.",
        "Install the battery", "Lay the battery in its bay, screw it down, and connect it to the board. Do not bend or press on the cells."),
    ],
  },
  printer: {
    id: "printer",
    name: "The 3D Printer",
    tagline: "Melt, move, repeat",
    short: "3D Printer",
    groundY: -1.7,
    focus: [0, 0, 0],
    camera: [2.3, 1.2, 4.8],
    model: MODELS.printer,
    parts: [
      mpart("enclosure", "Frame & Enclosure", "Rigid shell with a glass door", [0, 0, 0],
        "A stiff box that holds everything square. The closed sides keep warm air in, which stops prints from warping, and the rigid frame lets the head move fast without shaking.",
        "A frame that is out of square makes parts lean. Opening the door mid-print lets in a draft that can warp the plastic.",
        "Square the frame", "Assemble the frame on a flat surface and check the corners with a square before you tighten the bolts."),
      mpart("bed", "Heated Bed", "Flexible steel plate, heats to about 100 °C", [0, 0, 0],
        "The warm, flat plate the plastic sticks to. In this printer the bed moves down a little after every layer, while the head moves side to side above it.",
        "A bed that is not level gives a first layer that is squashed on one side and loose on the other, so the print peels off.",
        "Mount and level the bed", "Fit the bed onto its lead screws, lay the build plate on top, and run the leveling routine."),
      mpart("motion", "Motion System", "CoreXY belts, linear rails, stepper motors", [0, 0, 0],
        "Two motors and a pair of long belts move the head left, right, forward and back. Because the motors stay still and only the light head moves, this layout can print very quickly.",
        "A slack belt makes layers shift sideways. Dirt on the rails makes the head stick and leaves ripples in the print.",
        "Fit the belts and rails", "Mount the rails, thread both belts, and tension them evenly. The head should glide with no rough spots."),
      mpart("toolhead", "Toolhead & Hotend", "0.4 mm nozzle, up to about 300 °C", [0, 0, 0],
        "Gears push plastic filament into a hot block, where it melts and comes out of the nozzle in a thin line. A fan cools the plastic the moment it is laid down.",
        "A clogged nozzle gives thin or missing lines. If the cooling fan stops, heat creeps up and jams the filament.",
        "Attach the toolhead", "Bolt the toolhead to its carriage, plug in the heater, sensor and fans, and clip the cable so it cannot touch the nozzle."),
      mpart("screen", "Controller & Screen", "Touchscreen, mainboard, Wi-Fi", [0, 0, 0],
        "The printer's brain. It reads the sliced file, sends exact steps to each motor, and holds the nozzle and bed at the right temperature. The screen is how you start, pause and tune a print.",
        "A loose heater wire is the classic fire risk, so the printer shuts down if the temperature stops rising as expected.",
        "Wire the controller", "Connect each motor, heater and sensor to its labeled port, then run the self-test before the first print."),
      mpart("filament", "Filament System", "Four spools, automatic color switching", [0, 0, 0],
        "Four spools sit in a dry box on top. The printer pulls one filament out and feeds in another to change color or material in the middle of a print.",
        "Damp filament pops and strings as it prints. A tangle on the spool stops the feed, and the print fails partway.",
        "Load the filament", "Place each spool on its rollers, feed the end into its inlet until the feeder grabs it, and close the lid to keep the filament dry."),
    ],
  },
  reactor: {
    id: "reactor",
    name: "The Bioreactor",
    tagline: "A steel home for living cells",
    short: "Bioreactor",
    groundY: -1.7,
    focus: [0, 0.1, 0],
    camera: [1.8, 1.0, 5.2],
    model: MODELS.reactor,
    parts: [
      mpart("vessel", "Culture Vessel", "Polished stainless steel, water jacket", [0, 0, 0],
        "The steel tank where the cells grow. A jacket around it carries warm or cool water to hold the broth at an exact temperature. Everything inside is smooth so it can be cleaned and sterilized with steam.",
        "A scratch or a bad weld gives bacteria a place to hide from cleaning. One stray microbe can out-grow the culture and ruin the whole batch.",
        "Set the vessel on its frame", "Bolt the vessel to the skid, connect the jacket water lines, and check every clamp and gasket. Pressure-test it before first use."),
      mpart("sightglass", "Sight Glass", "Toughened glass window", [0, 0, 0],
        "A window in the tank wall. It lets the operator see the liquid level, the foam and the color without opening the vessel and breaking sterility.",
        "A worn gasket here is a common leak and contamination point, so the seals are replaced on a schedule.",
        "Fit the sight glass", "Seat a new gasket, fit the glass, and tighten the ring evenly. Check for leaks during the pressure test."),
      mpart("agitator", "Agitator Drive", "Motor, sealed shaft and impellers", [0, 0, 0],
        "A motor on top turns a shaft with paddles inside the tank. Stirring keeps the cells, food and oxygen mixed evenly. The speed is a balance: fast enough to mix, gentle enough not to tear fragile cells.",
        "A leaking shaft seal lets germs in. Stirring too hard kills cells, and stirring too slowly starves them of oxygen.",
        "Mount the agitator", "Lower the shaft and impellers into the vessel, fit the seal, and bolt the motor on top. Turn it by hand to check it runs free."),
      mpart("probes", "Sensor Probes", "pH, dissolved oxygen, temperature", [0, 0, 0],
        "Probes reach through ports into the broth and measure acidity, oxygen and temperature all the time. The controller uses those readings to keep conditions steady.",
        "Probes drift, so they are calibrated before every batch. A wrong pH reading makes the controller add acid or base the culture does not need.",
        "Install the probes", "Calibrate each probe, slide it into its port, and tighten the fitting. Plug each cable into the matching input on the controller."),
      mpart("lines", "Gas & Feed Lines", "Filtered air, oxygen, CO₂ and nutrients", [0, 0, 0],
        "Tubes bring in filtered air and oxygen, which bubble up through the broth from a sparger at the bottom. Other lines add food, acid or base, and anti-foam in small measured doses.",
        "A wet or blocked air filter starves the culture of oxygen. A kinked feed tube stops the nutrients, and growth stalls.",
        "Connect the gas and feed lines", "Fit sterile filters on every gas line, connect the sparger, and run each feed tube through its pump. Label every line."),
      mpart("harvest", "Harvest Valve", "Sanitary valve, steam sterilizable", [0, 0, 0],
        "The valve at the bottom of the tank. It is used to take samples during the run and to drain the finished product at the end. It is sterilized with steam before each use.",
        "If the valve is not steamed properly before sampling, it carries contamination straight into the vessel.",
        "Fit the harvest valve", "Clamp the valve to the bottom outlet with a new gasket, and connect its steam and drain lines."),
      mpart("controller", "Control Tower", "Touchscreen, pumps and control loops", [0, 0, 0],
        "The brain of the system. It reads the probes and adjusts stirring, gas flow, heating and the feed pumps to hold every setting. It also records the whole batch for quality checks.",
        "A badly tuned control loop makes temperature or pH swing up and down. Losing the batch record can mean the product cannot be released.",
        "Wire the control tower", "Connect the probes, motor, valves and pumps to the tower. Run a water test to check every loop before adding cells."),
    ],
  },
};

/* ------------------------------------------------------------------ */
/* 2. 3D scene and workspace UI                                       */
/* ------------------------------------------------------------------ */

function makeGeometry(s: Shape): THREE.BufferGeometry {
  switch (s.kind) {
    case "box":
      return new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
    case "cyl":
      return new THREE.CylinderGeometry(s.size[0], s.size[2] ?? s.size[0], s.size[1], 32);
    case "tor":
      return new THREE.TorusGeometry(s.size[0], s.size[1], 16, 48);
    default:
      return new THREE.SphereGeometry(s.size[0], 32, 32);
  }
}

interface ViewportProps {
  vehicleId: VehicleId;
  count: number;
  explode: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** one-shot camera command: fly to a part, or back to the home view. A new nonce means a new command. */
  cmd: { nonce: number; kind: "focus"; id: string } | { nonce: number; kind: "reset" } | null;
  /** part highlighted from outside the canvas (hovering a row in the Components panel) */
  hoverId: string | null;
  view: { grid: boolean; autoRotate: boolean };
}

/* ------------------------------------------------------------------ */
/* Built-in GLB reader and studio lighting. No add-on imports,      */
/* so this runs anywhere plain three.js does, old releases included.   */
/* It reads what our model files use: float mesh attributes, one PBR   */
/* material with base colour, metal-rough and normal textures, and     */
/* node translate/rotate/scale.                                        */
/* ------------------------------------------------------------------ */

type GltfJson = {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: {
    pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: TexInfo; metallicRoughnessTexture?: TexInfo };
    normalTexture?: TexInfo & { scale?: number };
    emissiveFactor?: number[];
    doubleSided?: boolean;
    alphaMode?: string;
  }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  buffers?: { byteLength: number; uri?: string }[];
};

type TexInfo = {
  index: number;
  extensions?: { KHR_texture_transform?: { offset?: number[]; scale?: number[]; rotation?: number } };
};

type Typed = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;
const GL_ARRAYS: Record<number, { new (n: number): Typed; BYTES_PER_ELEMENT: number }> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const GL_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const THREE_REV = parseInt(THREE.REVISION, 10) || 0;

/** marks a colour texture as sRGB on new three (colorSpace) and old three (encoding) */
function markSRGB(t: THREE.Texture) {
  const anyT = t as unknown as Record<string, unknown>;
  const anyThree = THREE as unknown as Record<string, unknown>;
  if ("colorSpace" in anyT && anyThree.SRGBColorSpace) anyT.colorSpace = anyThree.SRGBColorSpace;
}

/** Reads a .glb, or a .gltf/.json whose geometry is embedded as base64 or sits in its own file and whose
 *  textures are separate image files (the layout hosts that do not serve .glb need). */
async function loadGLB(url: string): Promise<THREE.Group> {
  const base = new URL(url, location.href);
  const res = await fetch(base.href);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  if (buf.byteLength >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    for (let off = 12; off + 8 <= buf.byteLength; ) {
      const len = dv.getUint32(off, true);
      const kind = dv.getUint32(off + 4, true);
      if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
      else if (kind === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
      off += 8 + len;
    }
  } else {
    const parsed: GltfJson = JSON.parse(new TextDecoder().decode(buf));
    json = parsed;
    const uri = parsed.buffers?.[0]?.uri;
    if (uri && uri.startsWith("data:")) {
      const raw = atob(uri.slice(uri.indexOf(",") + 1));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      bin = bytes.buffer;
    } else if (uri) {
      const r = await fetch(new URL(uri, base).href);
      if (!r.ok) throw new Error(`${uri}: HTTP ${r.status}`);
      bin = await r.arrayBuffer();
    }
  }
  if (!json || !bin) throw new Error(`${url}: missing model data`);
  const gl = json;
  const data = bin;

  const accessor = (i: number): { array: Typed; size: number; normalized: boolean } => {
    const a = gl.accessors![i];
    const view = gl.bufferViews![a.bufferView ?? 0];
    const Ctor = GL_ARRAYS[a.componentType];
    const size = GL_COMPONENTS[a.type];
    const elem = Ctor.BYTES_PER_ELEMENT;
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = view.byteStride ?? 0;
    const out = new Ctor(a.count * size);
    if (!stride || stride === elem * size) {
      out.set(new (Ctor as unknown as { new (b: ArrayBuffer): Typed })(data.slice(start, start + a.count * size * elem)));
    } else {
      // interleaved: copy one element at a time
      const src = new Uint8Array(data);
      const tmp = new Uint8Array(elem * size);
      const one = new (Ctor as unknown as { new (b: ArrayBuffer): Typed })(tmp.buffer);
      for (let k = 0; k < a.count; k++) {
        tmp.set(src.subarray(start + k * stride, start + k * stride + elem * size));
        out.set(one, k * size);
      }
    }
    return { array: out, size, normalized: !!a.normalized };
  };

  const texCache = new Map<number, Promise<THREE.Texture>>();
  const texture = (info: TexInfo, srgb: boolean): Promise<THREE.Texture> => {
    const i = info.index;
    let p = texCache.get(i);
    if (!p) {
      p = (async () => {
        const img = gl.images![gl.textures![i].source ?? 0];
        const el = new Image();
        if (img.uri) {
          el.src = new URL(img.uri, base).href;
          await el.decode();
        } else {
          const view = gl.bufferViews![img.bufferView ?? 0];
          const blob = new Blob([data.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)], { type: img.mimeType ?? "image/jpeg" });
          const src = URL.createObjectURL(blob);
          el.src = src;
          await el.decode();
          URL.revokeObjectURL(src);
        }
        const t = new THREE.Texture(el);
        t.flipY = false; // glTF images are stored top-down
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.needsUpdate = true;
        return t;
      })();
      texCache.set(i, p);
    }
    return p.then((t) => {
      if (srgb) markSRGB(t);
      // KHR_texture_transform: the UVs were packed into a smaller range and this undoes it
      const tf = info.extensions?.KHR_texture_transform;
      if (tf) {
        if (tf.offset) t.offset.fromArray(tf.offset);
        if (tf.scale) t.repeat.fromArray(tf.scale);
        if (tf.rotation) t.rotation = -tf.rotation;
        t.needsUpdate = true;
      }
      return t;
    });
  };

  const materials = await Promise.all(
    (gl.materials ?? [{}]).map(async (m) => {
      const pbr = m.pbrMetallicRoughness ?? {};
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().fromArray(pbr.baseColorFactor ?? [1, 1, 1]),
        metalness: pbr.metallicFactor ?? 1,
        roughness: pbr.roughnessFactor ?? 1,
        side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        transparent: m.alphaMode === "BLEND",
      });
      if (pbr.baseColorTexture) mat.map = await texture(pbr.baseColorTexture, true);
      if (pbr.metallicRoughnessTexture) {
        // glTF packs roughness in green and metalness in blue, which is what three reads from these maps
        const mr = await texture(pbr.metallicRoughnessTexture, false);
        mat.metalnessMap = mr;
        mat.roughnessMap = mr;
      }
      if (m.normalTexture) {
        mat.normalMap = await texture(m.normalTexture, false);
        const k = m.normalTexture.scale ?? 1;
        mat.normalScale.set(k, THREE_REV < 151 ? -k : k); // older three expected the green channel flipped
      }
      return mat;
    }),
  );

  const build = (ni: number): THREE.Object3D => {
    const n = gl.nodes![ni];
    let obj: THREE.Object3D;
    if (n.mesh !== undefined) {
      const meshes = gl.meshes![n.mesh].primitives.map((prim) => {
        const g = new THREE.BufferGeometry();
        const map: Record<string, string> = { POSITION: "position", NORMAL: "normal", TEXCOORD_0: "uv" };
        Object.entries(prim.attributes).forEach(([k, idx]) => {
          if (!map[k]) return;
          const a = accessor(idx);
          g.setAttribute(map[k], new THREE.BufferAttribute(a.array, a.size, a.normalized));
        });
        if (prim.indices !== undefined) g.setIndex(new THREE.BufferAttribute(accessor(prim.indices).array, 1));
        if (!g.getAttribute("normal")) g.computeVertexNormals();
        return new THREE.Mesh(g, materials[prim.material ?? 0]);
      });
      if (meshes.length === 1) obj = meshes[0];
      else { obj = new THREE.Group(); meshes.forEach((m) => obj.add(m)); }
    } else obj = new THREE.Group();
    obj.name = n.name ?? "";
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(obj.position, obj.quaternion, obj.scale);
    else {
      if (n.translation) obj.position.fromArray(n.translation);
      if (n.rotation) obj.quaternion.fromArray(n.rotation);
      if (n.scale) obj.scale.fromArray(n.scale);
    }
    (n.children ?? []).forEach((c) => obj.add(build(c)));
    return obj;
  };
  const root = new THREE.Group();
  (gl.scenes?.[gl.scene ?? 0]?.nodes ?? []).forEach((ni) => root.add(build(ni)));
  return root;
}

/** A soft studio for metal to reflect: a grey room with a few bright panels, pre-filtered for PBR. */
function makeStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mats: THREE.Material[] = [];
  const add = (color: THREE.Color, pos: Vec3, size: Vec3, side: THREE.Side = THREE.FrontSide) => {
    const m = new THREE.MeshBasicMaterial({ color, side });
    mats.push(m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(...pos);
    mesh.scale.set(...size);
    env.add(mesh);
  };
  add(new THREE.Color(0x9aa4bd), [0, 2, 0], [14, 9, 14], THREE.BackSide); // walls
  add(new THREE.Color(17, 17, 18), [0, 6.2, 0], [6, 0.1, 4]); // overhead soft box
  add(new THREE.Color(8.5, 8.8, 9.6), [-6.8, 2.4, 1], [0.1, 3.5, 5]); // left panel
  add(new THREE.Color(5.6, 5.8, 6.6), [6.8, 2.8, -1], [0.1, 2.5, 3]); // right panel
  add(new THREE.Color(3.8, 4.1, 4.8), [0, 1.6, -6.8], [5, 2, 0.1]); // back panel
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.04).texture;
  pm.dispose();
  geo.dispose();
  mats.forEach((m) => m.dispose());
  return tex;
}

/** Frees everything a loaded GLB scene holds: geometry, materials and their textures. */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
      Object.values(mat).forEach((val) => { if (val instanceof THREE.Texture) val.dispose(); });
      mat.dispose();
    });
  });
}

/** WebGL viewport: scene, orbit/zoom/pinch controls, hover and click picking. */
function Viewport({ vehicleId, count, explode, selectedId, onSelect, cmd, hoverId: extHover, view }: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState<"idle" | "loading" | "error">("idle");
  const labels = useRef(new Map<string, HTMLButtonElement>()); // hotspot name tags, positioned by the render loop
  // the render loop reads the latest props from here, so the scene is built once per vehicle
  const live = useRef({ count, explode, selectedId, onSelect, cmd, hoverId: extHover, view });
  live.current = { count, explode, selectedId, onSelect, cmd, hoverId: extHover, view };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = VEHICLES[vehicleId];

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // keeps bright parts from clipping to white
    renderer.toneMappingExposure = 0.9;
    const dom = renderer.domElement;
    dom.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab;";
    el.appendChild(dom);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    // three.js before r155 lit scenes about PI times brighter and point lights did not fade with distance,
    // so the same numbers blow everything out to white there (chat previews often run an old release)
    const legacy = THREE_REV < 155;
    const lit = (physical: number, distanceSq = 1) => (legacy ? physical / distanceSq / Math.PI : physical);
    scene.add(new THREE.AmbientLight(0xdbe7ff, lit(0.5)));
    const sun = new THREE.DirectionalLight(0xffffff, lit(1.6));
    sun.position.set(6, 9, 6);
    scene.add(sun);
    const rim = new THREE.PointLight(0x3b82f6, lit(35, 56));
    rim.position.set(-6, 2, -4);
    scene.add(rim);
    const fill = new THREE.PointLight(0x38bdf8, lit(22, 62));
    fill.position.set(6, -1, 5);
    scene.add(fill);
    const grid = new THREE.GridHelper(24, 48, 0x1e40af, 0x162036);
    grid.position.y = v.groundY;
    scene.add(grid);

    /* parts */
    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    const picks: THREE.Mesh[] = [];
    type Rig = {
      part: Part;
      group: THREE.Object3D;
      solids: Map<string, THREE.MeshStandardMaterial>;
      ghost: THREE.MeshBasicMaterial;
      meshes: { m: THREE.Mesh; solid: THREE.Material; base: THREE.Vector3; ex: THREE.Vector3 }[];
      k: number;
      base: THREE.Vector3;
      dir: THREE.Vector3;
      /** hotspot on a one-piece model */
      dot?: { mat: THREE.MeshBasicMaterial; halo: THREE.MeshBasicMaterial; from?: number };
    };
    let rigs: Rig[] = [];
    const tour = !!v.model && !v.model.parts; // one-piece model explored through hotspots
    let unit = 1; // scene units per model unit; explode vectors live in model units
    let disposed = false;
    const owned: THREE.Object3D[] = []; // loaded GLB scenes, disposed with the view
    let envTex: THREE.Texture | null = null;
    /* the finished machine: a faint blueprint while you build, the real thing once it is complete */
    let complete: { root: THREE.Object3D; meshes: { m: THREE.Mesh; solid: THREE.Material | THREE.Material[] }[]; blueprint: THREE.MeshBasicMaterial } | null = null;
    let completeMode: "hidden" | "blueprint" | "solid" | "" = "";
    const stage = v.model ? 1.15 : 1.8;
    if (!v.model) rigs = v.parts.map((p) => {
      const group = new THREE.Group();
      group.position.set(...p.position);
      const op = p.opacity ?? 1;
      const solids = new Map<string, THREE.MeshStandardMaterial>();
      const solidFor = (c: string) => {
        let m = solids.get(c);
        if (!m) {
          m = new THREE.MeshStandardMaterial({ color: c, metalness: 0.2, roughness: 0.45, transparent: op < 1, opacity: op, depthWrite: op >= 1 });
          solids.set(c, m);
          mats.push(m);
        }
        return m;
      };
      const ghost = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.55 });
      mats.push(ghost);
      const meshes = p.shapes.map((s) => {
        const g = makeGeometry(s);
        geos.push(g);
        const solid = solidFor(s.color ?? p.color);
        const m = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(g, solid);
        m.position.set(...s.pos);
        if (s.rot) m.rotation.set(...s.rot);
        if (s.scale) m.scale.set(...s.scale);
        m.userData.partId = p.id;
        m.userData.op = op;
        group.add(m);
        picks.push(m);
        return { m, solid, base: new THREE.Vector3(...s.pos), ex: new THREE.Vector3(...(s.ex ?? [0, 0, 0])) };
      });
      scene.add(group);
      return { part: p, group, solids, ghost, meshes, k: 0, base: new THREE.Vector3(...p.position), dir: new THREE.Vector3(...p.explode) };
    });

    if (v.model) {
      const model = v.model;
      unit = model.scale;
      // metal needs something to reflect, or it renders almost black
      const env = makeStudioEnvironment(renderer);
      envTex = env;
      const reflect = (m: THREE.Material) => {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial) return;
        sm.envMap = env;
        sm.envMapIntensity = 1.25;
      };
      setLoading("loading");
      Promise.all([model.parts ? loadGLB(model.parts) : Promise.resolve(null), loadGLB(model.complete)])
        .then(([partsScene, completeScene]) => {
          if (disposed) {
            if (partsScene) disposeTree(partsScene);
            disposeTree(completeScene);
            return;
          }
          if (partsScene) owned.push(partsScene);
          owned.push(completeScene);
          const root = new THREE.Group();
          root.scale.setScalar(unit);
          root.position.y = v.groundY;
          scene.add(root);
          const byName = new Map<string, THREE.Object3D>();
          partsScene?.traverse((o) => { if (o.name) byName.set(o.name, o); });
          if (!partsScene) {
            // one-piece model: each part is a glowing dot on the model, drawn on top so it is never hidden
            const dotGeo = new THREE.SphereGeometry(1, 20, 14);
            geos.push(dotGeo);
            rigs = v.parts.flatMap((p) => {
              const at = model.spots?.[p.id];
              if (!at) return [];
              const group = new THREE.Group();
              group.position.set(at[0], at[1], at[2]);
              root.add(group);
              const mat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, depthTest: false, transparent: true });
              const halo = new THREE.MeshBasicMaterial({ color: 0x38bdf8, depthTest: false, depthWrite: false, transparent: true, opacity: 0.28 });
              const ghost = new THREE.MeshBasicMaterial();
              mats.push(mat, halo, ghost);
              const core = new THREE.Mesh(dotGeo, mat);
              core.renderOrder = 11;
              const ring = new THREE.Mesh(dotGeo, halo);
              ring.scale.setScalar(2.4);
              ring.renderOrder = 10;
              ring.userData.partId = p.id; // the larger halo is the click target
              ring.userData.op = 2;
              picks.push(ring);
              group.add(ring, core);
              return [{ part: p, group, solids: new Map(), ghost, meshes: [], k: 0, base: group.position.clone(), dir: new THREE.Vector3(), dot: { mat, halo, from: at[3] } }];
            });
          } else rigs = v.parts.flatMap((p) => {
            const node = byName.get(p.node ?? p.id);
            if (!node) return [];
            // wrap each node so the explode offset moves the wrapper and the node keeps its baked pose
            const group = new THREE.Group();
            root.add(group);
            group.add(node);
            const solids = new Map<string, THREE.MeshStandardMaterial>();
            const ghost = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22, depthWrite: false });
            mats.push(ghost);
            const meshes: Rig["meshes"] = [];
            node.traverse((o) => {
              const m = o as THREE.Mesh;
              if (!m.isMesh) return;
              // a material per part, so highlighting one part does not light up the rest
              const solid = (m.material as THREE.MeshStandardMaterial).clone();
              reflect(solid);
              solids.set(m.uuid, solid);
              mats.push(solid);
              m.material = solid;
              m.userData.partId = p.id;
              m.userData.op = 1;
              picks.push(m);
              meshes.push({ m, solid, base: m.position.clone(), ex: new THREE.Vector3() });
            });
            return [{ part: p, group, solids, ghost, meshes, k: 0, base: new THREE.Vector3(), dir: new THREE.Vector3(...p.explode) }];
          });
          const blueprint = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.1, depthWrite: false });
          mats.push(blueprint);
          const cm: { m: THREE.Mesh; solid: THREE.Material | THREE.Material[] }[] = [];
          completeScene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            (Array.isArray(m.material) ? m.material : [m.material]).forEach(reflect);
            cm.push({ m, solid: m.material });
          });
          root.add(completeScene);
          complete = { root: completeScene, meshes: cm, blueprint };
          setLoading("idle");
        })
        .catch(() => { if (!disposed) setLoading("error"); });
    }

    /* orbit camera (spherical coordinates around the focus point) */
    const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
    const focus = new THREE.Vector3(...v.focus);
    const sph = new THREE.Spherical().setFromVector3(new THREE.Vector3(...v.camera).sub(focus));
    const applyCamera = () => {
      camera.position.setFromSpherical(sph).add(focus);
      camera.lookAt(focus);
    };
    /* camera fly-to: the loop eases focus / radius (and angles for a reset) toward this goal; any user input cancels it */
    let goal: { focus: THREE.Vector3; radius: number; theta?: number; phi?: number } | null = null;
    let lastCmd = 0;
    const startReset = () => {
      const home = new THREE.Spherical().setFromVector3(new THREE.Vector3(...v.camera).sub(new THREE.Vector3(...v.focus)));
      goal = { focus: new THREE.Vector3(...v.focus), radius: home.radius, theta: home.theta, phi: home.phi };
    };

    /* picking */
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let hoverId: string | null = null;
    const pick = (e: PointerEvent): string | null => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // solid parts win over see-through ones (so you can click an engine inside the body shell)
      const hit = ray.intersectObjects(picks, false).sort((a, b) => (b.object.userData.op - a.object.userData.op) || a.distance - b.distance)[0];
      return (hit?.object.userData.partId as string | undefined) ?? null;
    };

    /* pointer input: 1 pointer rotates, 2 pointers pinch-zoom */
    const ptrs = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...ptrs.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const onDown = (e: PointerEvent) => {
      goal = null;
      dom.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (ptrs.size === 2) pinch = spread();
    };
    const onMove = (e: PointerEvent) => {
      const prev = ptrs.get(e.pointerId);
      if (!prev) {
        hoverId = pick(e);
        dom.style.cursor = hoverId ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (ptrs.size === 1) {
        sph.theta -= dx * 0.008;
        sph.phi = clamp(sph.phi - dy * 0.008, 0.15, Math.PI * 0.52);
      } else if (ptrs.size === 2) {
        const d = spread();
        sph.radius = clamp((sph.radius * pinch) / d, 1.2, 26);
        pinch = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (ptrs.size === 1 && moved < 5) live.current.onSelect(pick(e));
      ptrs.delete(e.pointerId);
    };
    const onLeave = () => {
      hoverId = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      goal = null;
      sph.radius = clamp(sph.radius * (1 + e.deltaY * 0.0012), 1.2, 26);
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);
    dom.addEventListener("pointerleave", onLeave);
    dom.addEventListener("wheel", onWheel, { passive: false });

    /* keyboard: W/A/S/D walk the view across the floor, Q/E lower and raise it, Shift is faster, R recentres */
    const keys = new Set<string>();
    let fast = false;
    const typing = (t: EventTarget | null) => {
      const n = t as HTMLElement | null;
      return !!n && (n.tagName === "TEXTAREA" || (n.tagName === "INPUT" && (n as HTMLInputElement).type !== "range") || n.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      fast = e.shiftKey;
      if (k === "r") startReset();
      else if (k.length === 1 && "wasdqe".includes(k)) {
        keys.add(k);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      fast = e.shiftKey;
      keys.delete(e.key.toLowerCase());
    };
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    const [fx, fy, fz] = v.focus;

    /* sizing */
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    /* hotspots: fly to a dot, turning to the side it is best seen from */
    const dotPos = new THREE.Vector3();
    const aimAtDot = (r: Rig) => {
      r.group.getWorldPosition(dotPos);
      const from = r.dot?.from;
      goal = { focus: dotPos.clone(), radius: clamp(unit * 1.15, 1.6, 22), ...(from !== undefined ? { theta: (from * Math.PI) / 180, phi: 1.2 } : {}) };
    };
    let lastSel: string | null = null;
    let labelW = 0;
    let labelH = 0;
    const tags: { el: HTMLButtonElement; x: number; y: number }[] = [];

    /* render loop */
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const ease = 1 - Math.exp(-6 * dt);
      const { count: placed, explode: spreadAmt, selectedId: sel } = live.current;
      const c = live.current.cmd;
      if (c && c.nonce !== lastCmd) {
        lastCmd = c.nonce;
        if (c.kind === "reset") startReset();
        else {
          const i = rigs.findIndex((r) => r.part.id === c.id);
          if (i >= 0 && rigs[i].dot) aimAtDot(rigs[i]);
          else if (i >= 0) {
            const r = rigs[i];
            // aim where the part is heading (installed spot or staging spot), not where it is mid-flight
            r.group.updateWorldMatrix(true, true);
            const box = new THREE.Box3().setFromObject(r.group);
            box.translate(r.dir.clone().multiplyScalar(((i < placed ? spreadAmt : stage) - r.k) * unit));
            goal = { focus: box.getCenter(new THREE.Vector3()), radius: clamp(box.getSize(new THREE.Vector3()).length() * 1.35, 1.6, 22) };
          }
        }
      }
      if (tour && sel !== lastSel) {
        // picking a hotspot anywhere (dot, label, list, footer) flies the camera to it
        lastSel = sel;
        const r = rigs.find((x) => x.part.id === sel);
        if (r) aimAtDot(r);
      }
      if (tour) { labelW = dom.clientWidth; labelH = dom.clientHeight; }
      rigs.forEach((r, i) => {
        const installed = i < placed;
        // parts that are not installed float out in a staging position
        r.k += ((installed ? spreadAmt : stage) - r.k) * ease;
        r.group.position.copy(r.base).addScaledVector(r.dir, r.k);
        r.meshes.forEach((x) => {
          x.m.position.copy(x.base).addScaledVector(x.ex, r.k);
          x.m.material = installed ? x.solid : r.ghost;
        });
        const isSel = r.part.id === sel;
        const isHover = r.part.id === (hoverId ?? live.current.hoverId);
        r.solids.forEach((sm) => {
          sm.emissive.set(isSel ? 0x3b82f6 : isHover ? 0x38bdf8 : 0x000000);
          sm.emissiveIntensity = isSel ? 0.7 : isHover ? 0.4 : 0;
        });
        r.ghost.color.set(isSel ? 0x3b82f6 : 0x38bdf8);
        if (r.dot) {
          // keep the dot the same size on screen however far the camera is
          r.group.getWorldPosition(dotPos);
          const dist = camera.position.distanceTo(dotPos);
          r.group.scale.setScalar((dist * 0.0085 * (isSel ? 1.5 : isHover ? 1.25 : 1)) / unit);
          r.dot.mat.color.set(isSel ? 0xffffff : 0x7dd3fc);
          r.dot.halo.opacity = isSel ? 0.6 : isHover ? 0.45 : 0.24 + 0.1 * Math.sin(clock.elapsedTime * 3 + i);
          const el = labels.current.get(r.part.id);
          if (el) {
            dotPos.project(camera);
            const show = dotPos.z < 1 && (labelW >= 640 || isSel || isHover);
            el.style.display = show ? "block" : "none";
            if (show) {
              tags.push({ el, x: ((dotPos.x + 1) / 2) * labelW + 14, y: ((1 - dotPos.y) / 2) * labelH });
              el.style.borderColor = isSel ? "#38bdf8" : isHover ? "rgba(125,211,252,0.6)" : "";
              el.style.color = isSel ? "#ffffff" : "";
              el.style.zIndex = isSel ? "2" : "1";
            }
          }
        }
      });
      if (tags.length) {
        // name tags that would overlap are pushed down, top to bottom, so every one stays readable
        tags.sort((a, b) => a.y - b.y);
        for (let a = 0; a < tags.length; a++) {
          for (let b = 0; b < a; b++) {
            const near = Math.abs(tags[a].x - tags[b].x) < Math.max(tags[a].el.offsetWidth, tags[b].el.offsetWidth) + 8;
            if (near && tags[a].y - tags[b].y < 26) tags[a].y = tags[b].y + 26;
          }
          tags[a].el.style.transform = `translate(${tags[a].x}px, ${tags[a].y}px) translateY(-50%)`;
        }
        tags.length = 0;
      }
      if (complete) {
        // finished and closed up: show the one-piece model; otherwise the parts, over a faint blueprint while building
        const done = placed >= rigs.length && rigs.length > 0;
        const settled = rigs.every((r) => Math.abs(r.k - spreadAmt) < 0.01);
        const mode = tour || (done && spreadAmt < 0.005 && settled && !sel) ? "solid" : done ? "hidden" : "blueprint";
        if (mode !== completeMode) {
          completeMode = mode;
          const cpl = complete;
          cpl.root.visible = mode !== "hidden";
          cpl.meshes.forEach((x) => { x.m.material = mode === "solid" ? x.solid : cpl.blueprint; x.m.renderOrder = mode === "solid" ? 0 : 1; });
          rigs.forEach((r) => { r.group.visible = tour || mode !== "solid"; });
        }
      }
      grid.visible = live.current.view.grid;
      if (goal) {
        const g = goal;
        const k = 1 - Math.exp(-5 * dt);
        focus.lerp(g.focus, k);
        sph.radius += (g.radius - sph.radius) * k;
        if (g.theta !== undefined && g.phi !== undefined) {
          const d = g.theta - sph.theta;
          sph.theta += Math.atan2(Math.sin(d), Math.cos(d)) * k;
          sph.phi += (g.phi - sph.phi) * k;
        }
        if (focus.distanceTo(g.focus) < 0.01 && Math.abs(g.radius - sph.radius) < 0.02) goal = null;
      } else if (live.current.view.autoRotate && ptrs.size === 0) {
        sph.theta += dt * 0.3;
      }
      if (keys.size) {
        goal = null;
        camera.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() > 1e-4) {
          fwd.normalize();
          side.set(-fwd.z, 0, fwd.x);
          const step = (fast ? 9 : 4) * dt * clamp(sph.radius / 8, 0.5, 2);
          if (keys.has("w")) focus.addScaledVector(fwd, step);
          if (keys.has("s")) focus.addScaledVector(fwd, -step);
          if (keys.has("d")) focus.addScaledVector(side, step);
          if (keys.has("a")) focus.addScaledVector(side, -step);
        }
        const lift = (fast ? 6 : 3) * dt;
        if (keys.has("e")) focus.y += lift;
        if (keys.has("q")) focus.y -= lift;
        focus.set(clamp(focus.x, fx - 14, fx + 14), clamp(focus.y, v.groundY, fy + 8), clamp(focus.z, fz - 14, fz + 14));
      }
      applyCamera();
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      disposed = true;
      owned.forEach(disposeTree);
      envTex?.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("wheel", onWheel);
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      el.removeChild(dom);
    };
  }, [vehicleId]);

  return (
    <div ref={host} style={{ position: "absolute", inset: 0, overflow: "hidden" }} role="group" aria-label={`Interactive 3D model of ${VEHICLES[vehicleId].name}`}>
      {!failed && loading === "idle" && VEHICLES[vehicleId].model?.spots &&
        VEHICLES[vehicleId].parts.filter((p) => VEHICLES[vehicleId].model?.spots?.[p.id]).map((p) => (
          <button
            key={p.id}
            ref={(el) => { if (el) labels.current.set(p.id, el); else labels.current.delete(p.id); }}
            onClick={() => live.current.onSelect(p.id)}
            style={{ position: "absolute", left: 0, top: 0, display: "none" }}
            className="whitespace-nowrap rounded-md border border-white/15 bg-slate-950/85 px-2 py-1 text-xs font-bold uppercase tracking-wide text-slate-200 backdrop-blur"
          >
            {p.name}
          </button>
        ))}
      {!failed && loading !== "idle" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          {loading === "loading" ? (
            <p className="flex items-center gap-2.5 text-sm text-slate-400">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" aria-hidden />
              Loading the 3D model…
            </p>
          ) : (
            <div className="max-w-sm rounded-2xl border border-white/10 bg-slate-950/85 p-5 text-center backdrop-blur">
              <p className="text-sm font-semibold text-slate-200">No 3D model here</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
                A preview can&rsquo;t load model files. Run the site with the <code className="rounded bg-white/10 px-1 py-0.5 text-xs">.glb</code> files in <code className="rounded bg-white/10 px-1 py-0.5 text-xs">public/models</code> to see it.
              </p>
              <p className="mt-2.5 text-xs text-slate-500">The part list, tour and guide cards still work.</p>
            </div>
          )}
        </div>
      )}
      {failed && (
        <p className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-400">
          Your browser couldn't start WebGL. Turn on hardware acceleration or try another browser. You can still use the parts list and assembly steps below.
        </p>
      )}
    </div>
  );
}

type GuideTab = "what" | "fails" | "build";
const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: "what", label: "What it does" },
  { id: "fails", label: "If it fails" },
  { id: "build", label: "Assembly" },
];

interface GuideProps {
  part: Part;
  installed: boolean;
  tab: GuideTab;
  onTab: (t: GuideTab) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** where this part sits in the assembly order, for the Assembly tab */
  stepNo: number;
  total: number;
  prevName?: string;
  nextName?: string;
  onStep: (dir: -1 | 1) => void;
  /** true once the person has resized the card: the body then fills the card instead of using fixed heights */
  sized?: boolean;
  /** pointer handlers that make the header a drag handle */
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  /** resize grip, drawn in the card's corner */
  grip?: ReactNode;
}

/** Splits an instruction into separate lines. Only breaks before a capital letter, so "16 in. spacing" stays whole. */
const splitSentences = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);

/** Assembly notes: step counter, title, then one line per instruction, with previous/next step buttons. */
function AssemblyNotes({ part, stepNo, total, prevName, nextName, onStep, sized }: Pick<GuideProps, "part" | "stepNo" | "total" | "prevName" | "nextName" | "onStep" | "sized">) {
  const navBtn = "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className={sized ? "flex min-h-0 flex-1 flex-col" : ""}>
      <div className={`${sized ? "min-h-0 flex-1" : "max-h-40"} overflow-y-auto px-3.5 pb-2 pt-2.5`}>
        <p className="text-xs font-medium text-sky-300">Step {stepNo} of {total}</p>
        <p className="mt-0.5 text-sm font-semibold text-white">{part.step.title}</p>
        <ul className="mt-2 space-y-1.5">
          {splitSentences(part.step.instruction).map((line) => (
            <li key={line} className="flex gap-2 text-sm leading-snug text-slate-300">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue-400" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-2 py-1.5 pr-6">
        <button onClick={() => onStep(-1)} disabled={!prevName} title={prevName} className={navBtn}>
          <ArrowLeft className="h-3 w-3" /> Previous
        </button>
        <button onClick={() => onStep(1)} disabled={!nextName} title={nextName} className={navBtn}>
          Next <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/** Small card: one short section at a time, collapsible, closable. */
function GuidePanel({ part, installed, tab, onTab, open, onToggle, onClose, stepNo, total, prevName, nextName, onStep, sized, headerProps, grip }: GuideProps) {
  const body = tab === "what" ? part.what : part.failure;
  const iconBtn = "rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-white";
  return (
    <aside aria-label="AI Guide" className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/85 dx-sh-guide backdrop-blur-xl">
      <div
        {...headerProps}
        title="Drag to move · double-click to reset"
        className="flex shrink-0 cursor-grab touch-none select-none items-center gap-2.5 px-3.5 py-2.5 active:cursor-grabbing"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-500 text-slate-950 dx-sh-green-a">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{part.name}</p>
          <p className="truncate text-xs text-slate-500">{part.spec}</p>
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${installed ? "bg-sky-400 dx-sh-dot" : "border border-slate-500"}`} title={installed ? "Installed" : "Not installed"} />
        <button onClick={onToggle} className={iconBtn} aria-label={open ? "Collapse guide" : "Expand guide"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        <button onClick={onClose} className={iconBtn} aria-label="Close guide">
          <X className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className={`border-t border-white/10 ${sized ? "flex min-h-0 flex-1 flex-col" : ""}`}>
          <div className="flex shrink-0 gap-1 px-2.5 pt-2" role="tablist">
            {GUIDE_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => onTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${tab === t.id ? (t.id === "fails" ? "bg-amber-400/15 text-amber-200" : "bg-blue-500/15 text-blue-200") : "text-slate-500 hover:text-slate-200"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "build" ? (
            <AssemblyNotes part={part} stepNo={stepNo} total={total} prevName={prevName} nextName={nextName} onStep={onStep} sized={sized} />
          ) : (
            <p className={`${sized ? "min-h-0 flex-1" : "max-h-36"} overflow-y-auto px-3.5 pb-3.5 pt-2.5 text-sm leading-relaxed text-slate-300`}>{body}</p>
          )}
        </div>
      )}
      {open && grip}
    </aside>
  );
}

const TOOLBAR_GROUPS: { label: string; ids: VehicleId[] }[] = [
  { label: "Transport", ids: ["car", "moto"] },
  { label: "Machines", ids: ["arm", "printer", "prosthetic", "reactor"] },
  { label: "Electronics", ids: ["phone", "tablet", "computer"] },
  { label: "Structures", ids: ["house"] },
];
const ASSET_ICON: Record<VehicleId, ReactNode> = {
  car: <Car className="h-4 w-4" />, moto: <Bike className="h-4 w-4" />, arm: <Bot className="h-4 w-4" />,
  prosthetic: <Hand className="h-4 w-4" />, house: <Home className="h-4 w-4" />, phone: <Smartphone className="h-4 w-4" />,
  tablet: <Tablet className="h-4 w-4" />, computer: <Laptop className="h-4 w-4" />, printer: <Printer className="h-4 w-4" />,
  reactor: <FlaskConical className="h-4 w-4" />,
};

/* ------------------------------------------------------------------ */
/* Left rail: five buttons that open flyout panels (same pattern as    */
/* the Learn Arduino app). Zoom-to-part lives in the Components panel. */
/* ------------------------------------------------------------------ */

type RailPanel = "home" | "lessons" | "components" | "player" | "settings";

const RAIL_ITEMS: { id: RailPanel; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Machines", icon: <Home className="h-5 w-5" /> },
  { id: "lessons", label: "Lessons", icon: <BookOpen className="h-5 w-5" /> },
  { id: "components", label: "Components", icon: <Cpu className="h-5 w-5" /> },
  { id: "player", label: "Player", icon: <Play className="h-5 w-5" /> },
  { id: "settings", label: "Settings", icon: <Settings className="h-5 w-5" /> },
];

const RAIL_W = { open: 176, closed: 56 }; // px, matches w-44 / w-14 below

function SideRail({ expanded, onExpand, panel, onPanel }: { expanded: boolean; onExpand: () => void; panel: RailPanel | null; onPanel: (p: RailPanel | null) => void }) {
  return (
    <nav aria-label="Workspace tools" className={`absolute bottom-3 left-3 top-3 z-20 flex flex-col gap-1 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/85 p-1.5 backdrop-blur-xl dx-tw ${expanded ? "w-44" : "w-14"}`}>
      <button
        onClick={onExpand}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse rail" : "Expand rail"}
        title={expanded ? "Collapse" : "Expand"}
        className="mb-1 flex h-11 w-full shrink-0 items-center justify-center rounded-xl border border-white/10 text-slate-400 transition hover:border-blue-500/50 hover:text-white"
      >
        {expanded ? <ChevronsLeft className="h-5 w-5" /> : <ChevronsRight className="h-5 w-5" />}
      </button>
      {RAIL_ITEMS.map((it) => {
        const on = panel === it.id;
        return (
          <button
            key={it.id}
            onClick={() => onPanel(on ? null : it.id)}
            aria-pressed={on}
            aria-label={it.label}
            title={it.label}
            className={`flex h-12 w-full shrink-0 items-center gap-3 rounded-xl transition ${expanded ? "px-3" : "justify-center"} ${on ? "bg-blue-500/20 text-blue-200" : "text-slate-400 hover:bg-white/10 hover:text-white"}`}
          >
            {it.icon}
            {expanded && <span className="truncate text-sm font-semibold">{it.label}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** Shared frame for every flyout: title, small count, close button, scrolling body. */
function PanelShell({ title, meta, expanded, onClose, children }: { title: string; meta?: string; expanded: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      style={{ left: (expanded ? RAIL_W.open : RAIL_W.closed) + 20, width: "21rem", maxWidth: "calc(100% - 6rem)", maxHeight: "calc(100% - 1.5rem)" }}
      className="absolute top-3 z-20 flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/90 backdrop-blur-xl dx-sh-guide"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
        <h2 className="flex-1 text-sm font-bold uppercase tracking-wider text-white">{title}</h2>
        {meta && <span className="text-xs font-semibold text-slate-500">{meta}</span>}
        <button onClick={onClose} aria-label={`Close ${title}`} className="rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </section>
  );
}

const rowBase = "flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition";

function MachinesPanel({ current, onSwitch, onExit, ...shell }: { current: VehicleId; onSwitch: (v: VehicleId) => void; onExit: () => void; expanded: boolean; onClose: () => void }) {
  return (
    <PanelShell title="Machines" meta={`${Object.keys(VEHICLES).length} available`} {...shell}>
      {TOOLBAR_GROUPS.map((g) => (
        <div key={g.label} className="mb-1">
          <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{g.label}</p>
          {g.ids.map((id) => (
            <button key={id} onClick={() => onSwitch(id)} aria-current={current === id} className={`${rowBase} items-center ${current === id ? "bg-blue-500/15" : "dx-hover-lift"}`}>
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${current === id ? "border-blue-400/60 text-blue-200" : "border-white/10 text-slate-400"}`}>{ASSET_ICON[id]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-white">{VEHICLES[id].name}</span>
                <span className="block truncate text-xs text-slate-400">{VEHICLES[id].tagline}</span>
              </span>
              {current === id && <Check className="h-4 w-4 shrink-0 text-sky-400" />}
            </button>
          ))}
        </div>
      ))}
      <button onClick={onExit} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-blue-500/50 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Back to catalog
      </button>
    </PanelShell>
  );
}

function LessonsPanel({ parts, count, selectedId, onGo, ...shell }: { parts: Part[]; count: number; selectedId: string | null; onGo: (id: string) => void; expanded: boolean; onClose: () => void }) {
  return (
    <PanelShell title="Lessons" meta={`${count}/${parts.length} done`} {...shell}>
      {parts.map((p, i) => {
        const done = i < count;
        const isNext = i === count;
        return (
          <button key={p.id} onClick={() => onGo(p.id)} className={`${rowBase} ${selectedId === p.id ? "bg-blue-500/15" : "dx-hover-lift"}`}>
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-sky-500 text-slate-950" : isNext ? "border border-sky-400 text-sky-300" : "border border-slate-600 text-slate-500"}`}>
              {done ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-white">{p.step.title}</span>
              <span className="block truncate text-xs text-slate-400">{p.name}</span>
            </span>
            {isNext && <span className="mt-1 shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-300">Next</span>}
          </button>
        );
      })}
    </PanelShell>
  );
}

function ComponentsPanel({ parts, count, selectedId, onZoom, onHover, onFit, ...shell }: { parts: Part[]; count: number; selectedId: string | null; onZoom: (id: string) => void; onHover: (id: string | null) => void; onFit: () => void; expanded: boolean; onClose: () => void }) {
  return (
    <PanelShell title="Components" meta={`${count} in view`} {...shell}>
      {parts.map((p, i) => {
        const installed = i < count;
        return (
          <button
            key={p.id}
            onClick={() => onZoom(p.id)}
            onMouseEnter={() => onHover(p.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(p.id)}
            onBlur={() => onHover(null)}
            aria-label={`Zoom to ${p.name}`}
            className={`${rowBase} ${selectedId === p.id ? "bg-blue-500/15" : "dx-hover-lift"}`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${selectedId === p.id ? "border-blue-400/60 text-blue-200" : "border-white/10"} ${installed ? "text-sky-300" : "text-slate-500"}`}>
              <Crosshair className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-bold uppercase tracking-wide ${installed ? "text-white" : "text-slate-400"}`}>{p.name}</span>
              <span className="block text-xs text-slate-400">{installed ? p.spec : `${p.spec} · not installed`}</span>
            </span>
          </button>
        );
      })}
      <button onClick={onFit} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-blue-500/50 hover:text-white">
        <RotateCcw className="h-4 w-4" /> Show whole machine
      </button>
    </PanelShell>
  );
}

function PlayerPanel({ playing, onToggle, onRestart, speed, onSpeed, count, total, stepTitle, tour, ...shell }: { tour?: boolean; playing: boolean; onToggle: () => void; onRestart: () => void; speed: number; onSpeed: (s: number) => void; count: number; total: number; stepTitle?: string; expanded: boolean; onClose: () => void }) {
  return (
    <PanelShell title="Player" meta={`${count}/${total} ${tour ? "visited" : "placed"}`} {...shell}>
      <div className="space-y-3 px-2 pb-2 pt-1">
        <p className="text-sm leading-relaxed text-slate-300">{tour ? "Take the guided tour. The camera visits each part in turn and opens its notes." : "Watch the machine build itself. Each part flies in, the camera follows, and the assembly notes open for that step."}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={count} aria-valuemin={0} aria-valuemax={total} aria-label="Assembly progress">
          <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500" style={{ width: `${(count / total) * 100}%` }} />
        </div>
        <p className="text-xs text-slate-400">{stepTitle ? <>Next: <span className="font-semibold text-sky-300">{stepTitle}</span></> : tour ? "Tour complete." : "Fully assembled."}</p>
        <div className="flex gap-2">
          <button onClick={onToggle} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 dx-sh-go transition hover:bg-sky-400">
            {playing ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> {count >= total ? "Replay" : count > 0 ? "Resume" : "Play"}</>}
          </button>
          <button onClick={onRestart} aria-label="Restart" title="Restart" className="flex w-12 items-center justify-center rounded-xl border border-white/10 text-slate-300 transition hover:border-blue-500/50 hover:text-white">
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
        <div role="group" aria-label="Speed" className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 p-1">
          {[0.5, 1, 2].map((s) => (
            <button key={s} onClick={() => onSpeed(s)} aria-pressed={speed === s} className={`rounded-lg py-1.5 text-xs font-semibold transition ${speed === s ? "bg-blue-500/20 text-blue-200" : "text-slate-400 hover:text-white"}`}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition dx-hover-lift">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-white">{label}</span>
        {hint && <span className="block text-xs text-slate-400">{hint}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-sky-500" : "bg-slate-700"}`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
      </span>
    </button>
  );
}

type ViewSettings = { grid: boolean; autoRotate: boolean };

function SettingsPanel({ view, onView, showGuide, onGuide, onReset, ...shell }: { view: ViewSettings; onView: (v: ViewSettings) => void; showGuide: boolean; onGuide: (v: boolean) => void; onReset: () => void; expanded: boolean; onClose: () => void }) {
  const kbd = "rounded border border-white/15 px-1.5 py-0.5 text-xs text-slate-300";
  return (
    <PanelShell title="Settings" {...shell}>
      <Switch on={view.grid} onChange={(grid) => onView({ ...view, grid })} label="Floor grid" hint="Shows the reference grid under the machine." />
      <Switch on={view.autoRotate} onChange={(autoRotate) => onView({ ...view, autoRotate })} label="Auto-rotate" hint="Slowly spins the view while you are not touching it." />
      <Switch on={showGuide} onChange={onGuide} label="Guide card" hint="The card that opens when you pick a part." />
      <div className="px-2 py-2">
        <button onClick={onReset} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-blue-500/50 hover:text-white">
          <RotateCcw className="h-4 w-4" /> Reset camera
        </button>
      </div>
      <div className="mx-2 mb-1 mt-3 border-t border-white/10 pt-3">
        <p className="pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Controls</p>
        <ul className="space-y-1.5 text-xs text-slate-400">
          <li className="flex items-center justify-between"><span>Orbit</span><span>Drag</span></li>
          <li className="flex items-center justify-between"><span>Zoom</span><span>Scroll or pinch</span></li>
          <li className="flex items-center justify-between"><span>Move</span><span className="flex gap-1"><kbd className={kbd}>W</kbd><kbd className={kbd}>A</kbd><kbd className={kbd}>S</kbd><kbd className={kbd}>D</kbd></span></li>
          <li className="flex items-center justify-between"><span>Down / up</span><span className="flex gap-1"><kbd className={kbd}>Q</kbd><kbd className={kbd}>E</kbd></span></li>
          <li className="flex items-center justify-between"><span>Recentre</span><kbd className={kbd}>R</kbd></li>
        </ul>
      </div>
    </PanelShell>
  );
}

/** Where the guide card sits inside the stage, in px. null = the default corner spot. */
type GuideBox = { x: number; y: number; w: number; h: number | null };

/** Wraps the guide card so it can be dragged by its header and resized from the corner grip. */
function FloatingGuide({ box, setBox, ...guide }: GuideProps & { box: GuideBox | null; setBox: (b: GuideBox | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const op = useRef<{ mode: "drag" | "size"; dx: number; dy: number; w: number; h: number; x: number; y: number } | null>(null);
  const clamp = (n: number, a: number, b: number) => Math.min(Math.max(n, a), Math.max(a, b));

  /** current size and place relative to the stage; also pins the card there so it stops following the default CSS spot */
  const grab = (e: React.PointerEvent, mode: "drag" | "size") => {
    const el = ref.current;
    const stage = el?.offsetParent as HTMLElement | null;
    if (!el || !stage) return;
    const r = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const x = box?.x ?? r.left - s.left;
    const y = box?.y ?? r.top - s.top;
    op.current = { mode, dx: e.clientX, dy: e.clientY, w: box?.w ?? r.width, h: box?.h ?? r.height, x, y };
    setBox({ x, y, w: box?.w ?? r.width, h: box?.h ?? null });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent) => {
    const o = op.current;
    const stage = ref.current?.offsetParent as HTMLElement | null;
    if (!o || !stage) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const mx = e.clientX - o.dx;
    const my = e.clientY - o.dy;
    if (o.mode === "drag") {
      setBox({ x: clamp(o.x + mx, 0, sw - o.w), y: clamp(o.y + my, 0, sh - 48), w: o.w, h: box?.h ?? null });
    } else {
      setBox({ x: o.x, y: o.y, w: clamp(o.w + mx, 240, Math.min(560, sw - o.x)), h: clamp(o.h + my, 150, sh - o.y) });
    }
  };
  const release = () => {
    op.current = null;
  };

  // a window resize could strand the card off-screen, so it goes back to its default spot
  useEffect(() => {
    const reset = () => setBox(null);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, [setBox]);

  const placed = box
    ? { left: box.x, top: box.y, width: box.w, height: guide.open && box.h ? box.h : undefined }
    : undefined;

  return (
    <div ref={ref} style={placed} className={box ? "absolute z-10" : "absolute bottom-3 left-20 right-3 z-10 lg:left-auto lg:right-3 lg:w-80"}>
      <GuidePanel
        {...guide}
        sized={!!box?.h && guide.open}
        headerProps={{ onPointerDown: (e) => { if (!(e.target as HTMLElement).closest("button")) grab(e, "drag"); }, onPointerMove: move, onPointerUp: release, onPointerCancel: release, onDoubleClick: () => setBox(null) }}
        grip={
          <div
            onPointerDown={(e) => grab(e, "size")}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
            onDoubleClick={() => setBox(null)}
            title="Drag to resize · double-click to reset"
            aria-label="Resize guide card"
            className="absolute bottom-0 right-0 flex h-6 w-6 cursor-nwse-resize touch-none items-end justify-end p-1"
          >
            <span className="block h-2.5 w-2.5 border-b-2 border-r-2 border-slate-500" />
          </div>
        }
      />
    </div>
  );
}

function Studio({ vehicleId, onSwitch, onExit, toolbarOpen, onToolbar, view, onView }: { vehicleId: VehicleId; onSwitch: (v: VehicleId) => void; onExit: () => void; toolbarOpen: boolean; onToolbar: () => void; view: ViewSettings; onView: (v: ViewSettings) => void }) {
  const v = VEHICLES[vehicleId];
  const n = v.parts.length;
  const [count, setCount] = useState(n); // number of parts currently installed
  const [explode, setExplode] = useState(0); // 0 = the finished product, fully closed up
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<RailPanel | null>(null); // which rail flyout is open
  const [cmd, setCmd] = useState<ViewportProps["cmd"]>(null); // camera commands for the viewport
  const [hoverId, setHoverId] = useState<string | null>(null); // part highlighted from the Components list
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showGuide, setShowGuide] = useState(true);
  const [tab, setTab] = useState<GuideTab>("what");
  const [guideOpen, setGuideOpen] = useState(true);
  const [guideBox, setGuideBox] = useState<GuideBox | null>(null); // where the person dragged / sized the card

  // Esc: first closes the guide card, then leaves the workspace
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (panel) setPanel(null);
      else if (selectedId) setSelectedId(null);
      else onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, selectedId, panel]);

  const selectedIdx = v.parts.findIndex((p) => p.id === selectedId);
  const selected = selectedIdx >= 0 ? v.parts[selectedIdx] : null;
  const tour = !!v.model && !v.model.parts; // one-piece model: explore hotspots, nothing to assemble
  const next = count < n ? v.parts[count] : null;
  const pct = Math.round(((tour ? selectedIdx + 1 : count) / n) * 100);

  /** picking a part opens its card on the first tab */
  const selectPart = (id: string | null) => {
    setSelectedId(id);
    if (id) {
      setTab("what");
      setGuideOpen(true);
    }
  };

  /** previous / next step in the Assembly tab; stays on that tab so the notes read as one sequence */
  const goStep = (dir: -1 | 1) => {
    const target = v.parts[selectedIdx + dir];
    if (target) setSelectedId(target.id);
  };

  const fly = (id: string) => setCmd({ nonce: Math.random(), kind: "focus", id });
  const resetView = () => setCmd({ nonce: Math.random(), kind: "reset" });
  /** Components panel: pick the part, open its card, and fly the camera to it */
  const zoomTo = (id: string) => {
    selectPart(id);
    fly(id);
  };
  /** Lessons panel: same, but open the card on the Assembly tab */
  const goLesson = (id: string) => {
    setSelectedId(id);
    setTab("build");
    setGuideOpen(true);
    fly(id);
  };

  /** Player: places one part per tick, flies to it, and opens its assembly notes */
  useEffect(() => {
    if (!playing) return;
    if (tour) {
      // guided tour: visit the next hotspot, stop after the last one
      const t = setTimeout(() => {
        const nextPart = v.parts[selectedIdx + 1];
        if (!nextPart) { setPlaying(false); return; }
        setSelectedId(nextPart.id);
        setTab("what");
        setGuideOpen(true);
      }, selectedIdx < 0 ? 400 : 3200 / speed);
      return () => clearTimeout(t);
    }
    if (count >= n) {
      const t = setTimeout(() => { setPlaying(false); resetView(); }, 1400 / speed);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      const p = v.parts[count];
      setSelectedId(p.id);
      setTab("build");
      setGuideOpen(true);
      setCount(count + 1);
      fly(p.id);
    }, 1300 / speed);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, count, speed, n, v, tour, selectedIdx]);
  const restartPlayer = () => {
    if (tour) { setSelectedId(null); resetView(); setPlaying(true); return; }
    setCount(0);
    setExplode(0);
    setSelectedId(null);
    resetView();
    setPlaying(true);
  };
  const togglePlayer = () => {
    if (playing) setPlaying(false);
    else if (tour ? selectedIdx >= n - 1 : count >= n) restartPlayer();
    else setPlaying(true);
  };

  const assemble = () => {
    setPlaying(false);
    if (!next) return;
    setSelectedId(next.id);
    setCount(count + 1);
    if (count + 1 === n) setExplode(0); // last part in: close everything up into the finished product
  };
  const disassemble = () => {
    setPlaying(false);
    if (count === 0) return;
    setSelectedId(v.parts[count - 1].id);
    setCount(count - 1);
  };

  const toggleBtn = (on: boolean) =>
    `hidden h-9 w-9 items-center justify-center rounded-lg border transition lg:flex ${on ? "border-blue-500/50 bg-blue-500/10 text-blue-300" : "border-white/10 text-slate-500 hover:text-white"}`;

  return (
    // fixed + inline styles: the workspace always fills the screen, whatever the page around it does
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", gridTemplateColumns: "minmax(0, 1fr)", background: "#060a14", color: "#eef3fb" }}>
      {/* top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-slate-950 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={onExit} title="Back to catalog (Esc)" className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:border-sky-500/50 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight text-white">{v.name}</h1>
            <p className="hidden text-xs text-slate-500 sm:block">{v.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGuide((x) => !x)} className={toggleBtn(showGuide)} title="Guide card" aria-label="Toggle guide card" aria-pressed={showGuide}>
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* stage: the 3D view fills this whole rectangle, panels float over its sides */}
      <main style={{ position: "relative", minHeight: 0, overflow: "hidden", background: "radial-gradient(ellipse at 50% 45%, #0c1c3a 0%, #060a14 72%)" }}>
        <Viewport vehicleId={vehicleId} count={count} explode={explode} selectedId={selectedId} onSelect={selectPart} cmd={cmd} hoverId={hoverId} view={view} />

        <SideRail expanded={toolbarOpen} onExpand={onToolbar} panel={panel} onPanel={setPanel} />
        {panel === "home" && <MachinesPanel current={vehicleId} onSwitch={onSwitch} onExit={onExit} expanded={toolbarOpen} onClose={() => setPanel(null)} />}
        {panel === "lessons" && <LessonsPanel parts={v.parts} count={count} selectedId={selectedId} onGo={goLesson} expanded={toolbarOpen} onClose={() => setPanel(null)} />}
        {panel === "components" && <ComponentsPanel parts={v.parts} count={count} selectedId={selectedId} onZoom={zoomTo} onHover={setHoverId} onFit={resetView} expanded={toolbarOpen} onClose={() => { setPanel(null); setHoverId(null); }} />}
        {panel === "player" && <PlayerPanel playing={playing} onToggle={togglePlayer} onRestart={restartPlayer} speed={speed} onSpeed={setSpeed} tour={tour} count={tour ? selectedIdx + 1 : count} total={n} stepTitle={tour ? v.parts[selectedIdx + 1]?.name : next?.step.title} expanded={toolbarOpen} onClose={() => setPanel(null)} />}
        {panel === "settings" && <SettingsPanel view={view} onView={onView} showGuide={showGuide} onGuide={setShowGuide} onReset={resetView} expanded={toolbarOpen} onClose={() => setPanel(null)} />}

        {/* guide card: appears only when a part is selected, small and in the corner */}
        {showGuide && selected && (
          <>
            <FloatingGuide
              box={guideBox}
              setBox={setGuideBox}
              part={selected}
              installed={selectedIdx >= 0 && selectedIdx < count}
              tab={tab}
              onTab={setTab}
              open={guideOpen}
              onToggle={() => setGuideOpen((o) => !o)}
              onClose={() => setSelectedId(null)}
              stepNo={selectedIdx + 1}
              total={n}
              prevName={v.parts[selectedIdx - 1]?.step.title}
              nextName={v.parts[selectedIdx + 1]?.step.title}
              onStep={goStep}
            />
          </>
        )}

        {/* explode control */}
        <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-col items-center gap-2 lg:bottom-3 lg:top-auto">
          {!tour && <div className="pointer-events-auto w-64 rounded-xl border border-white/10 bg-slate-950/75 px-3.5 py-2.5 backdrop-blur-xl">
            <label htmlFor="explode" className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className="flex items-center gap-1.5"><Layers className="h-3.5 w-3.5 text-blue-400" /> Exploded view</span>
              <span className="text-blue-300">{Math.round(explode * 100)}%</span>
            </label>
            <input id="explode" type="range" min={0} max={100} value={Math.round(explode * 100)} onChange={(e) => setExplode(Number(e.target.value) / 100)} className="mt-2.5 w-full accent-blue-400" />
          </div>}
          <p className="hidden text-xs text-slate-500 lg:block">Drag to orbit · Scroll to zoom · WASD to move (Shift = faster, Q/E down/up, R recentre) · Click a {tour ? "hotspot" : "part"}</p>
        </div>
      </main>

      {/* bottom: assembly tracker */}
      <footer className="relative border-t border-white/10 bg-slate-950 px-3 pb-3 pt-4 sm:px-5">
        <div className="absolute inset-x-0 top-0 h-1 bg-slate-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Assembly progress">
          <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 dx-sh-progress transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-3 xl:flex-row xl:items-center">
          <ol className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {v.parts.map((p, i) => {
              const done = !tour && i < count;
              const isNext = !tour && i === count;
              return (
                <li key={p.id} className="shrink-0">
                  <button
                    onClick={() => selectPart(p.id)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                      selectedId === p.id ? "border-blue-400 bg-blue-500/15 text-white" : isNext ? "border-sky-500/60 text-sky-200 dx-sh-green-b" : "border-white/10 text-slate-400 hover:border-white/30"
                    }`}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-sky-500 text-slate-950" : "border border-slate-600"}`}>
                      {done ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    {p.name}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="flex shrink-0 items-center gap-2">
            <span className="mr-1 hidden text-sm text-slate-400 sm:block">{tour ? `${n} parts` : `${count}/${n} placed`}</span>
            <button onClick={tour ? () => { setPlaying(false); goStep(-1); } : disassemble} disabled={tour ? selectedIdx <= 0 : count === 0} className="flex items-center gap-1.5 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-blue-500/60 disabled:cursor-not-allowed disabled:opacity-35">
              {tour ? <><ArrowLeft className="h-4 w-4" /> Previous</> : <><Minus className="h-4 w-4" /> Disassemble</>}
            </button>
            <button onClick={tour ? () => { setPlaying(false); selectPart(v.parts[selectedIdx + 1]?.id ?? null); } : assemble} disabled={tour ? selectedIdx >= n - 1 : !next} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 dx-sh-go transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none">
              {tour ? <>Next part <ArrowRight className="h-4 w-4" /></> : <><Plus className="h-4 w-4" /> Assemble</>}
            </button>
          </div>
        </div>
        <div className="mx-auto mt-2 max-w-screen-2xl">
          {tour ? (
            <p className="truncate text-sm text-slate-400">
              {selected ? <span className="font-semibold text-sky-300">Part {selectedIdx + 1} of {n}: {selected.name}</span> : <span className="font-semibold text-sky-300">Click a glowing dot on the model, or press Next part to start the tour.</span>}
            </p>
          ) : next ? (
            <button
              onClick={() => { setSelectedId(next.id); setTab("build"); setGuideOpen(true); }}
              className="block max-w-full truncate text-left text-sm text-slate-400 transition hover:text-slate-200"
              title="Show the instructions for this step"
            >
              <span className="font-semibold text-sky-300">Step {count + 1} of {n}: {next.step.title}</span>
              <span className="text-slate-500"> · tap for instructions</span>
            </button>
          ) : (
            <p className="truncate text-sm font-semibold text-sky-300">Fully assembled. Drag the exploded view slider to inspect it, or disassemble to start over.</p>
          )}
        </div>
      </footer>
    </div>
  );
}

function InteractiveWorkspace({ vehicleId, onExit }: { vehicleId: VehicleId; onExit: () => void }) {
  const [id, setId] = useState<VehicleId>(vehicleId);
  const [toolbarOpen, setToolbarOpen] = useState(false); // rail expanded; lives here so it survives switching machines
  const [view, setView] = useState<ViewSettings>({ grid: true, autoRotate: false });
  // key resets assembly state when the vehicle changes
  return <Studio key={id} vehicleId={id} onSwitch={setId} onExit={onExit} toolbarOpen={toolbarOpen} onToolbar={() => setToolbarOpen((o) => !o)} view={view} onView={setView} />;
}

/* ------------------------------------------------------------------ */
/* 3. Landing page                                                    */
/* ------------------------------------------------------------------ */

const NAV_LINKS = [
  { label: "Machines", href: "#masterclasses" },
  { label: "The method", href: "#method" },
  { label: "Hardware bridge", href: "#hardware" },
];

type Build = {
  icon: ReactNode;
  name: string;
  domain: string;
  description: string;
  accent: "emerald" | "cyan";
  vehicle?: VehicleId;
};

const BUILDS: Build[] = [
  {
    icon: <Car className="h-6 w-6" />,
    name: "The Automobile",
    vehicle: "car",
    domain: "Automotive Engineering",
    description:
      "Follow power from the first combustion stroke to the tire. Strip down the powertrain, learn why piston geometry sets an engine's character, then rebuild the transmission and differential so you can feel how torque gets split in a corner.",
    accent: "emerald",
  },
  {
    icon: <Bike className="h-6 w-6" />,
    name: "The Motorcycle",
    vehicle: "moto",
    domain: "Chassis & Kinematics",
    description:
      "Bolt an engine block into a frame, run the chain drive, and tune suspension geometry. Find out why a bike stays upright, how rake and trail change steering, and what happens to the load when you brake hard.",
    accent: "cyan",
  },
  {
    icon: <Bot className="h-6 w-6" />,
    name: "The Robotic Arm",
    vehicle: "arm",
    domain: "Mechatronics & Robotics",
    description:
      "Build a six-axis industrial arm from the base up: base casting, shoulder, both arm links, the counterbalance, a three-axis wrist, and the cabinet that drives it all. Every joint, gear and motor is a real part you can pull out and inspect.",
    accent: "emerald",
  },
  {
    icon: <Hand className="h-6 w-6" />,
    name: "The Prosthetic",
    vehicle: "prosthetic",
    domain: "Biomechanics",
    description:
      "Build a cable-driven hand where one tendon curls one finger. Design a socket that spreads load across the limb instead of one pressure point, and close the loop with a muscle sensor that tells the hand when to grip.",
    accent: "cyan",
  },
  {
    icon: <Home className="h-6 w-6" />,
    name: "The House",
    vehicle: "house",
    domain: "Civil & Structural Engineering",
    description:
      "Frame the walls, size the joists, and trace how every pound of roof ends up in the ground. Then run electrical circuits through the studs and lay out a plumbing system that holds pressure and drains cleanly.",
    accent: "emerald",
  },
  {
    icon: <Smartphone className="h-6 w-6" />,
    name: "The Smartphone",
    vehicle: "phone",
    domain: "Consumer Electronics",
    description: "Open up a phone layer by layer: frame, logic board, battery, display. See why each sits where it does and what fails first.",
    accent: "cyan",
  },
  {
    icon: <Tablet className="h-6 w-6" />,
    name: "The Tablet",
    vehicle: "tablet",
    domain: "Hardware Repair",
    description: "A big screen over a bigger battery. Learn how thin devices stay stiff, stay cool, and still come apart for repair.",
    accent: "emerald",
  },
  {
    icon: <Laptop className="h-6 w-6" />,
    name: "The Laptop",
    vehicle: "computer",
    domain: "Computer Hardware & IT",
    description: "Explore a laptop from lid to battery: display, hinge, keyboard, logic board, cooling and cells. See how much engineering fits in a slim case.",
    accent: "cyan",
  },
  {
    icon: <Printer className="h-6 w-6" />,
    name: "The 3D Printer",
    vehicle: "printer",
    domain: "Manufacturing & Mechatronics",
    description: "Explore an enclosed multi-color printer: frame, heated bed, fast belt-driven motion, toolhead and a four-spool filament system.",
    accent: "emerald",
  },
  {
    icon: <FlaskConical className="h-6 w-6" />,
    name: "The Bioreactor",
    vehicle: "reactor",
    domain: "Bioprocess Engineering",
    description: "Tour a stainless steel bioreactor: vessel, agitator, probes, gas lines and control tower. Learn how living cells are kept fed, warm and sterile at scale.",
    accent: "cyan",
  },
];

const STEPS = [
  {
    n: "01",
    icon: <Move3d className="h-5 w-5" />,
    title: "Tear it down",
    body: "Orbit it. Zoom in. Pull every part loose. Tap one and your mentor says what it does, why it’s there, and what breaks without it.",
  },
  {
    n: "02",
    icon: <Wrench className="h-5 w-5" />,
    title: "Put it back",
    body: "Snap each part home in the right order. Get it wrong and the build tells you what’s in the way. Torque, fit, tolerance: you pick it up as you go.",
  },
  {
    n: "03",
    icon: <Hammer className="h-5 w-5" />,
    title: "Make your own",
    body: "Blank canvas. Real goals. Run the sim and see if it holds. This is where you find out what you actually know.",
  },
];

const HARDWARE_FILES = [
  { name: "differential_housing.stl", meta: "3D-print ready, 0.2 mm layers" },
  { name: "arm_base_bracket.step", meta: "Editable in Fusion, SolidWorks, FreeCAD" },
  { name: "bill_of_materials.csv", meta: "42 parts, links and quantities" },
  { name: "stepper_wiring.svg", meta: "Microcontroller pinout and schematic" },
];

/* Landing-page styling lives in THEME_CSS below (plain CSS, no Tailwind custom values), so it renders the same in any setup. */
const THEME_CSS = String.raw`
.theme-root {
  display: contents;
  --bg: #060a14; --ink: #eef3fb; --mute: #94a3b8; --dim: #64748b;
  --line: rgba(255, 255, 255, 0.08); --accent: #3b82f6; --coral: #818cf8; --action: #6cb4ff;
  font-family: 'Schibsted Grotesk', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.dx-page *, .dx-page *::before, .dx-page *::after { box-sizing: border-box; }
.dx-page a { text-decoration: none; color: inherit; }
.dx-page ul, .dx-page ol { list-style: none; margin: 0; padding: 0; }
.dx-page h1, .dx-page h2, .dx-page h3, .dx-page p { margin: 0; }

/* ---- page shell: deep navy, faint grid, blue glows ---- */
.dx-page { position: relative; isolation: isolate; min-height: 100vh; overflow-x: hidden; background: var(--bg); color: var(--ink); scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }
.dx-page::selection { background: rgba(59, 130, 246, 0.35); }
.dx-bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
.dx-bg-grid { background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px); background-size: 56px 56px; -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); }
.dx-bg-glow { height: 1100px; background: radial-gradient(ellipse 60% 55% at 12% 6%, rgba(37, 99, 235, 0.30), transparent 70%); }
.dx-bg-ember { inset: auto 0 auto auto; top: 1500px; width: 900px; height: 900px; background: radial-gradient(circle, rgba(99, 102, 241, 0.11), transparent 65%); }
.dx-wrap { width: 100%; max-width: 1200px; margin: 0 auto; padding: 0 clamp(1.25rem, 4vw, 2rem); }

/* ---- buttons ---- */
.dx-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem; padding: 0.95rem 1.6rem; border: 1px solid transparent; border-radius: 16px; font: 600 1rem/1 inherit; font-family: inherit; cursor: pointer; white-space: nowrap; transition: transform .15s, background .15s, border-color .15s, color .15s, box-shadow .15s; }
.dx-btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 3px; }
.dx-btn--solid { background: var(--action); color: #060a14; box-shadow: 0 10px 34px -10px rgba(108, 180, 255, 0.7); }
.dx-btn--solid:hover { background: #8cc6ff; transform: translateY(-1px); }
.dx-btn--ghost { background: rgba(255, 255, 255, 0.03); border-color: rgba(255, 255, 255, 0.16); color: #e2e8f0; }
.dx-btn--ghost:hover { border-color: rgba(59, 130, 246, 0.55); color: #93c5fd; }
.dx-btn--sm { padding: 0.7rem 1.15rem; font-size: 0.92rem; border-radius: 14px; }
.dx-btn--block { width: 100%; }

/* ---- header ---- */
.dx-header { position: sticky; top: 0; z-index: 50; border-bottom: 1px solid var(--line); background: rgba(11, 8, 6, 0.74); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
.dx-header-in { display: flex; align-items: center; justify-content: space-between; gap: 1rem; height: 76px; }
.dx-logo { display: flex; align-items: center; gap: 0.8rem; border-radius: 12px; }
.dx-logo:focus-visible { outline: 2px solid #93c5fd; outline-offset: 4px; }
.dx-logo-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--ink); color: #060a14; }
.dx-logo-mark svg { transition: transform .5s; }
.dx-logo:hover .dx-logo-mark svg { transform: rotate(90deg); }
.dx-logo-text { display: grid; line-height: 1.15; }
.dx-logo-name { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
.dx-logo-tag { font-size: 0.66rem; font-weight: 500; letter-spacing: 0.28em; text-transform: uppercase; color: var(--dim); }
.dx-links { display: none; gap: 2rem; }
.dx-links a { font-size: 0.92rem; font-weight: 500; color: var(--mute); transition: color .15s; }
.dx-links a:hover { color: var(--ink); }
.dx-header-end { display: flex; align-items: center; gap: 1.25rem; }
.dx-meta { display: none; font-size: 1.05rem; color: var(--mute); }
.dx-header-cta { display: none; }
.dx-burger { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: #cbd5e1; cursor: pointer; }
.dx-mobile { border-top: 1px solid var(--line); background: var(--bg); padding: 0.75rem 0 1.25rem; }
.dx-mobile a.dx-mlink { display: block; padding: 0.85rem 0.5rem; font-size: 1.1rem; color: #cbd5e1; border-bottom: 1px solid var(--line); }
.dx-mobile .dx-btn { margin-top: 1.25rem; }
@media (min-width: 768px) { .dx-header-cta { display: inline-flex; } .dx-burger, .dx-mobile { display: none; } }
@media (min-width: 1024px) { .dx-links { display: flex; } }
@media (min-width: 1200px) { .dx-meta { display: block; } }

/* ---- type ---- */
.dx-eyebrow { display: inline-flex; align-items: center; gap: 0.8rem; padding: 0.55rem 1.1rem; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, 0.03); font-size: 0.74rem; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #cbd5e1; }
.dx-eyebrow i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px rgba(59, 130, 246, 0.9); }
.dx-grad { background: linear-gradient(90deg, #7dd3fc, #60a5fa 55%, #818cf8); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: #60a5fa; }
.dx-h1 { max-width: 62rem; margin-top: 2rem; font-size: clamp(2.9rem, 8.2vw, 6.4rem); font-weight: 700; line-height: 0.98; letter-spacing: -0.035em; color: var(--ink); }
.dx-h1 > span { display: block; }
.dx-h2 { max-width: 56rem; margin-top: 1.75rem; font-size: clamp(2.2rem, 5.5vw, 4.25rem); font-weight: 700; line-height: 1.02; letter-spacing: -0.03em; color: var(--ink); }
.dx-lead { max-width: 40rem; margin-top: 1.75rem; font-size: clamp(1.1rem, 2vw, 1.3rem); line-height: 1.6; color: var(--mute); }

/* ---- hero ---- */
.dx-hero { padding: clamp(3.5rem, 8vw, 6.5rem) 0 6rem; }
.dx-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 2.25rem; }
.dx-steps { display: flex; flex-wrap: wrap; gap: 1rem 2.5rem; margin-top: 3.5rem; }
.dx-steps a { display: flex; align-items: center; gap: 0.8rem; font-size: 1.1rem; color: #cbd5e1; transition: color .15s; }
.dx-steps a:hover { color: var(--ink); }
.dx-steps b { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: rgba(59, 130, 246, 0.15); box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.32); font-size: 0.85rem; font-weight: 600; color: #93c5fd; }
.dx-rise { animation: dx-rise .75s cubic-bezier(.2, .7, .2, 1) both; }
@keyframes dx-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .dx-rise, .dx-ping { animation: none !important; } }

/* ---- sections ---- */
.dx-section { padding: 7rem 0; border-top: 1px solid var(--line); scroll-margin-top: 76px; }
.dx-grid { display: grid; gap: 1.25rem; margin-top: 3.5rem; grid-template-columns: 1fr; }
@media (min-width: 640px) { .dx-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .dx-grid { grid-template-columns: repeat(6, 1fr); } .dx-span2 { grid-column: span 2; } .dx-span3 { grid-column: span 3; } }

.dx-card { position: relative; display: flex; flex-direction: column; height: 100%; overflow: hidden; padding: 1.75rem; border: 1px solid var(--line); border-radius: 24px; background: rgba(255, 255, 255, 0.025); transition: border-color .2s, background .2s, transform .2s; }
.dx-card::after { content: ""; position: absolute; top: -70px; right: -70px; width: 190px; height: 190px; border-radius: 50%; background: radial-gradient(circle, rgba(59, 130, 246, 0.28), transparent 70%); opacity: 0; transition: opacity .3s; pointer-events: none; }
.dx-card:hover { border-color: rgba(59, 130, 246, 0.42); background: rgba(255, 255, 255, 0.045); transform: translateY(-2px); }
.dx-card:hover::after { opacity: 1; }
.dx-card > * { position: relative; z-index: 1; }
.dx-card-top { display: flex; align-items: flex-start; justify-content: space-between; }
.dx-ico { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 16px; background: rgba(59, 130, 246, 0.1); box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.3); color: #60a5fa; }
.dx-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; color: #475569; }
.dx-domain { margin-top: 1.75rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(147, 197, 253, 0.85); }
.dx-card h3 { margin-top: 0.5rem; font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; color: var(--ink); }
.dx-card p.dx-body { flex: 1; margin-top: 0.75rem; font-size: 0.95rem; line-height: 1.6; color: var(--mute); }
.dx-link { display: inline-flex; align-items: center; gap: 0.5rem; align-self: flex-start; margin-top: 1.75rem; padding: 0; border: 0; background: none; font: 600 0.92rem/1 inherit; font-family: inherit; color: var(--action); cursor: pointer; transition: gap .2s; }
.dx-card:hover .dx-link { gap: 0.8rem; }
.dx-link:disabled { opacity: .5; cursor: not-allowed; }
.dx-link:focus-visible { outline: 2px solid var(--action); outline-offset: 4px; border-radius: 6px; }

.dx-method { display: grid; gap: 1.25rem; margin-top: 3.5rem; grid-template-columns: 1fr; }
@media (min-width: 1024px) { .dx-method { grid-template-columns: repeat(3, 1fr); } }
.dx-bignum { position: absolute !important; top: -1.5rem; right: -0.25rem; z-index: 0 !important; font-size: 8rem; font-weight: 800; line-height: 1; letter-spacing: -0.05em; color: rgba(255, 255, 255, 0.04); user-select: none; }
.dx-method .dx-card { padding: 2rem; }
.dx-method .dx-card:hover { transform: none; }
.dx-method h3 { margin-top: 2rem; }

.dx-bridge { display: grid; gap: 3rem; align-items: center; padding: clamp(2rem, 5vw, 3.5rem); border: 1px solid rgba(59, 130, 246, 0.22); border-radius: 32px; background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(255, 255, 255, 0.02) 45%, transparent); }
@media (min-width: 1024px) { .dx-bridge { grid-template-columns: 1fr 1fr; } }
.dx-bridge .dx-h2 { font-size: clamp(2.2rem, 5vw, 3.75rem); }
.dx-ticks { display: grid; gap: 0.8rem; margin-top: 1.75rem; font-size: 1.1rem; color: #cbd5e1; }
.dx-ticks li { display: flex; gap: 0.75rem; align-items: baseline; }
.dx-ticks svg { flex: none; align-self: center; color: var(--action); }
.dx-bridge .dx-btn { margin-top: 2.25rem; }
.dx-files { padding: 1.5rem; border: 1px solid var(--line); border-radius: 20px; background: rgba(11, 8, 6, 0.85); box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.9); }
.dx-files-title { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: var(--dim); }
.dx-files li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.95rem 0; border-top: 1px solid var(--line); }
.dx-files ul { margin-top: 1rem; }
.dx-files li:first-child { border-top: 0; }
.dx-files code { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88rem; color: #f1f5f9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dx-files small { display: block; margin-top: 0.15rem; font-size: 0.75rem; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dx-pill { flex: none; padding: 0.25rem 0.7rem; border: 1px solid rgba(108, 180, 255, 0.32); border-radius: 999px; background: rgba(108, 180, 255, 0.1); font-size: 0.75rem; font-weight: 500; color: var(--action); }

.dx-cta { position: relative; overflow: hidden; padding: 8rem 0; border-top: 1px solid var(--line); text-align: center; scroll-margin-top: 76px; }
.dx-cta::before { content: ""; position: absolute; inset: 0; z-index: -1; background: radial-gradient(ellipse 55% 60% at 50% 110%, rgba(59, 130, 246, 0.24), transparent); }
.dx-cta .dx-h2 { margin: 0 auto; font-size: clamp(2.4rem, 6.5vw, 5rem); line-height: 1; letter-spacing: -0.035em; }
.dx-cta .dx-lead { margin-left: auto; margin-right: auto; max-width: 30rem; }
.dx-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 30rem; margin: 2.25rem auto 0; }
@media (min-width: 640px) { .dx-form { flex-direction: row; } }
.dx-input { flex: 1; min-width: 0; padding: 0.95rem 1.25rem; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 16px; background: rgba(255, 255, 255, 0.04); font: 400 1.05rem/1.2 inherit; font-family: inherit; color: #f1f5f9; }
.dx-input::placeholder { color: var(--dim); }
.dx-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.28); }
.dx-done { display: inline-flex; align-items: center; gap: 0.6rem; margin-top: 2.25rem; padding: 0.85rem 1.25rem; border: 1px solid rgba(108, 180, 255, 0.4); border-radius: 16px; background: rgba(108, 180, 255, 0.1); color: var(--action); }

.dx-footer { padding: 2.5rem 0; border-top: 1px solid var(--line); }
.dx-footer-in { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 1.5rem; }
.dx-footer small { font-size: 0.85rem; color: var(--dim); }
.dx-footer ul { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem 1.5rem; font-size: 0.9rem; color: var(--mute); }
.dx-footer ul a:hover { color: var(--ink); }
.dx-footer .dx-socials a { padding: 0.4rem 0.9rem; border: 1px solid var(--line); border-radius: 12px; transition: border-color .15s, color .15s; }
.dx-footer .dx-socials a:hover { border-color: rgba(59, 130, 246, 0.5); color: #93c5fd; }
.dx-footer-brand { display: flex; align-items: center; gap: 1.25rem; }
@media (min-width: 768px) { .dx-footer-in { flex-direction: row; } }

.dx-fab { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 40; }
.dx-fab-btn { position: relative; display: grid; place-items: center; width: 64px; height: 64px; border: 0; border-radius: 50%; background: var(--action); color: #060a14; cursor: pointer; box-shadow: 0 12px 40px -6px rgba(108, 180, 255, 0.65); transition: transform .15s, background .15s; }
.dx-fab-btn:hover { transform: scale(1.06); background: #8cc6ff; }
.dx-fab-btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 3px; }
.dx-ping { position: absolute; inset: 0; border-radius: 50%; background: rgba(108, 180, 255, 0.32); animation: dx-ping 2s cubic-bezier(0, 0, .2, 1) infinite; }
@keyframes dx-ping { 75%, 100% { transform: scale(1.7); opacity: 0; } }

/* ---- sandbox + preview: stand-ins for the custom-value classes ---- */
.dx-preview-bg { background: radial-gradient(ellipse at center, #0c1c3a 0%, #060a14 70%); aspect-ratio: 16 / 10; min-height: 260px; }
.dx-split { display: grid; }
@media (min-width: 768px) { .dx-split { grid-template-columns: 1fr 220px; } }
.dx-toolbar-max { max-height: calc(100% - 1.5rem); }
.dx-tw { transition: width .2s; }
.dx-sh-guide { box-shadow: 0 20px 50px -20px rgba(0, 0, 0, 0.9); }
.dx-sh-progress { box-shadow: 0 0 12px rgba(59, 130, 246, 0.9); }
.dx-sh-tool { box-shadow: 0 0 16px rgba(59, 130, 246, 0.5); }
.dx-sh-go { box-shadow: 0 0 24px -6px rgba(56, 189, 248, 0.9); }
.dx-sh-green-a { box-shadow: 0 0 14px rgba(56, 189, 248, 0.6); }
.dx-sh-green-b { box-shadow: 0 0 16px -4px rgba(56, 189, 248, 0.7); }
.dx-sh-green-c { box-shadow: 0 0 30px -8px rgba(56, 189, 248, 0.6); }
.dx-sh-dot { box-shadow: 0 0 8px rgba(56, 189, 248, 0.9); }
.dx-hover-lift:hover { background: rgba(255, 255, 255, 0.05); }
`;

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

function Logo() {
  return (
    <a href="#top" className="dx-logo" aria-label="DIY Sandbox, home">
      <span className="dx-logo-mark"><Cog size={24} /></span>
      <span className="dx-logo-text">
        <span className="dx-logo-name">DIY Sandbox</span>
        <span className="dx-logo-tag">Build · Break · Learn</span>
      </span>
    </a>
  );
}

/** One button for the whole page: a real <button> when it does something, a link when it goes somewhere. */
function Btn({ children, href = "#cta", onClick, variant = "solid", small, block, className }: { children: ReactNode; href?: string; onClick?: () => void; variant?: "solid" | "ghost"; small?: boolean; block?: boolean; className?: string }) {
  const cls = cx("dx-btn", `dx-btn--${variant}`, small && "dx-btn--sm", block && "dx-btn--block", className);
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>{children}</button>
  ) : (
    <a className={cls} href={href}>{children}</a>
  );
}

/** Tracked-caps pill with an orange dot, used above every big heading. */
function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="dx-eyebrow"><i aria-hidden />{children}</span>;
}

function Nav({ onLaunch }: { onLaunch: (v: VehicleId) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="dx-header">
      <div className="dx-wrap dx-header-in">
        <Logo />
        <nav className="dx-links" aria-label="Main">
          {NAV_LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
        </nav>
        <div className="dx-header-end">
          <p className="dx-meta">10 machines · free to try</p>
          <Btn small className="dx-header-cta" onClick={() => onLaunch("car")}><Hammer size={16} /> Start building</Btn>
          <button className="dx-burger" onClick={() => setOpen((v) => !v)} aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="dx-mobile">
          <nav className="dx-wrap" aria-label="Mobile">
            {NAV_LINKS.map((l) => <a key={l.href} className="dx-mlink" href={l.href} onClick={() => setOpen(false)}>{l.label}</a>)}
            <Btn block onClick={() => { setOpen(false); onLaunch("car"); }}><Hammer size={18} /> Start building</Btn>
          </nav>
        </div>
      )}
    </header>
  );
}

/** Exploded differential. Toggle slides the parts apart along the axle. */
function DifferentialView({ exploded }: { exploded: boolean }) {
  const t = (x: number, y = 0) => ({
    transform: `translate(${exploded ? x : 0}px, ${exploded ? y : 0}px)`,
    transition: "transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
  });
  return (
    <svg viewBox="0 0 520 300" className="h-full w-full" role="img" aria-label="Exploded view of a differential: ring gear, carrier, spider gears and side gears">
      <defs>
        <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <path d="M 26 0 L 0 0 0 26" fill="none" stroke="#27272a" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="520" height="300" fill="url(#grid)" opacity="0.6" />
      {/* axle */}
      <line x1="20" y1="150" x2="500" y2="150" stroke="#3f3f46" strokeWidth="2" strokeDasharray="4 6" />
      {/* left axle shaft + side gear */}
      <g style={t(-95)}>
        <rect x="70" y="140" width="80" height="20" rx="3" fill="#18181b" stroke="#52525b" />
        <polygon points="150,118 190,132 190,168 150,182" fill="#052e2b" stroke="#3b82f6" strokeWidth="1.5" />
      </g>
      {/* right axle shaft + side gear */}
      <g style={t(95)}>
        <rect x="370" y="140" width="80" height="20" rx="3" fill="#18181b" stroke="#52525b" />
        <polygon points="370,118 330,132 330,168 370,182" fill="#052e2b" stroke="#3b82f6" strokeWidth="1.5" />
      </g>
      {/* ring gear + carrier */}
      <g style={t(0, 0)}>
        <circle cx="260" cy="150" r="82" fill="#0c1f1a" stroke="#38bdf8" strokeWidth="2" strokeDasharray="7 4" />
        <circle cx="260" cy="150" r="60" fill="#060a14" stroke="#3f3f46" strokeWidth="1.5" />
      </g>
      {/* spider gears */}
      <g style={t(0, -52)}>
        <circle cx="260" cy="150" r="16" fill="#064e3b" stroke="#34d399" strokeWidth="1.5" />
      </g>
      <g style={t(0, 52)}>
        <circle cx="260" cy="150" r="16" fill="#064e3b" stroke="#34d399" strokeWidth="1.5" />
      </g>
      <line x1="260" y1="100" x2="260" y2="200" stroke="#34d399" strokeWidth="2" opacity="0.7" />
      {/* callout on spider gear */}
      <g style={t(0, -52)} className="pointer-events-none">
        <circle cx="260" cy="150" r="26" fill="none" stroke="#34d399" strokeWidth="1" opacity="0.7">
          <animate attributeName="r" values="22;30;22" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0;0.8" dur="2.4s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

function HeroPreview() {
  const [exploded, setExploded] = useState(true);
  return (
    <div className="relative mx-auto mt-14 w-full max-w-4xl">
      <div className="absolute -inset-x-10 -inset-y-8 -z-10 rounded-3xl bg-blue-500/10 blur-3xl" aria-hidden />
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/60">
        {/* window chrome */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-2.5">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          </div>
          <p className="text-xs text-slate-500">The Automobile / Teardown / Differential</p>
          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-400">
            Live preview
          </span>
        </div>

        <div className="dx-split">
          {/* canvas */}
          <div className="relative dx-preview-bg">
            <DifferentialView exploded={exploded} />
            <button
              onClick={() => setExploded((v) => !v)}
              className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-sky-500/60 hover:text-sky-300"
              aria-pressed={exploded}
            >
              <Layers className="h-3.5 w-3.5" />
              {exploded ? "Reassemble" : "Explode view"}
            </button>

            {/* AI guide bubble */}
            <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:max-w-sm">
              <div className="rounded-xl border border-sky-500/40 bg-slate-900/95 p-4 dx-sh-green-c backdrop-blur">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500 text-slate-950">
                    <Bot className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-xs font-semibold text-sky-300">DIY Guide</span>
                </div>
                <p className="text-sm leading-relaxed text-slate-200">
                  This is the differential. It lets your inside wheels spin slower than your outside wheels when taking a curve. Strip it down to see the spider gears inside.
                </p>
              </div>
            </div>
          </div>

          {/* parts panel */}
          <aside className="hidden border-l border-slate-800 bg-slate-900/40 p-4 md:block" aria-label="Parts list">
            <p className="mb-3 text-xs font-medium text-slate-500">Parts in this view</p>
            <ul className="space-y-2 text-sm">
              {["Ring gear", "Carrier", "Spider gears (2)", "Side gears (2)", "Axle shafts (2)"].map((p, i) => (
                <li key={p} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${i === 2 ? "border-sky-500/50 bg-sky-500/10 text-sky-200" : "border-slate-800 text-slate-400"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${i === 2 ? "bg-sky-400" : "bg-slate-600"}`} />
                  {p}
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}

const HERO_STEPS = [
  { n: 1, label: "Pick a machine", href: "#masterclasses" },
  { n: 2, label: "Pull it apart", href: "#method" },
  { n: 3, label: "Build it back", href: "#method" },
];

function Hero({ onLaunch }: { onLaunch: (v: VehicleId) => void }) {
  const delay = (ms: number) => ({ animationDelay: `${ms}ms` });
  return (
    <section id="top" className="dx-hero" aria-labelledby="hero-title">
      <div className="dx-wrap">
        <div className="dx-rise"><Eyebrow>3D Sandbox</Eyebrow></div>
        <h1 id="hero-title" className="dx-h1 dx-rise" style={delay(80)}>
          <span>Learn the trade,</span>
          <span><b className="dx-grad" style={{ fontWeight: "inherit" }}>bolt by bolt</b>,</span>
          <span>before day one.</span>
        </h1>
        <p className="dx-lead dx-rise" style={delay(180)}>
          Pick a machine. Tear it down in 3D. Rebuild it step by step while an AI mentor explains every part. No lectures. No guesswork.
        </p>
        <div className="dx-actions dx-rise" style={delay(260)}>
          <Btn onClick={() => onLaunch("car")}><Hammer size={18} /> Start building</Btn>
          <Btn variant="ghost" href="#masterclasses">See the 10 machines <ArrowRight size={16} /></Btn>
        </div>
        <ol className="dx-steps dx-rise" style={delay(340)} aria-label="How it works">
          {HERO_STEPS.map((s) => (
            <li key={s.n}><a href={s.href}><b>{s.n}</b>{s.label}</a></li>
          ))}
        </ol>
      </div>
      <div className="dx-wrap"><HeroPreview /></div>
    </section>
  );
}

function BuildCard({ b, n, onLaunch }: { b: Build; n: number; onLaunch: (v: VehicleId) => void }) {
  return (
    <article className="dx-card">
      <div className="dx-card-top">
        <span className="dx-ico">{b.icon}</span>
        <span className="dx-num">{String(n).padStart(2, "0")}</span>
      </div>
      <p className="dx-domain">{b.domain}</p>
      <h3>{b.name}</h3>
      <p className="dx-body">{b.description}</p>
      <button className="dx-link" onClick={() => b.vehicle && onLaunch(b.vehicle)} disabled={!b.vehicle}>
        {b.vehicle ? "Open in sandbox" : "Coming soon"} <ArrowRight size={16} />
      </button>
    </article>
  );
}

function Catalog({ onLaunch }: { onLaunch: (v: VehicleId) => void }) {
  return (
    <section id="masterclasses" className="dx-section" aria-labelledby="catalog-title">
      <div className="dx-wrap">
        <Eyebrow>Masterclasses</Eyebrow>
        <h2 id="catalog-title" className="dx-h2">Ten machines.<br /><span className="dx-grad">Zero lectures.</span></h2>
        <p className="dx-lead">Pick one. Pull it apart. Find out why it works.</p>
        <div className="dx-grid">
          {BUILDS.map((b, i) => (
            <div key={b.name} className={i < 3 || i > 6 ? "dx-span2" : "dx-span3"}>
              <BuildCard b={b} n={i + 1} onLaunch={onLaunch} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Method() {
  return (
    <section id="method" className="dx-section" aria-labelledby="method-title">
      <div className="dx-wrap">
        <Eyebrow>The Method</Eyebrow>
        <h2 id="method-title" className="dx-h2">Take it apart. Put it back.<br /><span className="dx-grad">Then prove it.</span></h2>
        <p className="dx-lead">The same three moves run through every machine, so you always know what’s next.</p>
        <ol className="dx-method">
          {STEPS.map((s) => (
            <li key={s.n} className="dx-card">
              <span className="dx-bignum" aria-hidden>{s.n}</span>
              <span className="dx-ico">{s.icon}</span>
              <h3>{s.title}</h3>
              <p className="dx-body">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function HardwareBridge() {
  return (
    <section id="hardware" className="dx-section" aria-labelledby="hardware-title">
      <div className="dx-wrap">
        <div className="dx-bridge">
          <div>
            <Eyebrow>Hardware Bridge</Eyebrow>
            <h2 id="hardware-title" className="dx-h2">From screen<br /><span className="dx-grad">to workbench.</span></h2>
            <p className="dx-lead">Finished a build on screen? Make the real one. Print the parts, buy the rest, wire it up.</p>
            <ul className="dx-ticks">
              {["Print-ready STL and STEP files", "A parts list with sizes and quantities", "Wiring diagrams, pin by pin"].map((t) => (
                <li key={t}><Check size={16} /><span>{t}</span></li>
              ))}
            </ul>
            <Btn>See a sample export</Btn>
          </div>
          <div className="dx-files">
            <p className="dx-files-title">Export · Robotic Arm · v1</p>
            <ul>
              {HARDWARE_FILES.map((f) => (
                <li key={f.name}>
                  <div style={{ minWidth: 0 }}><code>{f.name}</code><small>{f.meta}</small></div>
                  <span className="dx-pill">Ready</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function CTAAndFooter() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) return;
    // TODO: connect to your waitlist API route
    setDone(true);
  };
  return (
    <>
      <section id="cta" className="dx-cta" aria-labelledby="cta-title">
        <div className="dx-wrap">
          <h2 id="cta-title" className="dx-h2">Don’t make your first try<br /><span className="dx-grad">your first day.</span></h2>
          <p className="dx-lead">Join the waitlist. Get in first when the next machines drop.</p>
          {done ? (
            <p className="dx-done" role="status"><Check size={16} /> You’re on the list. Watch your inbox.</p>
          ) : (
            <form className="dx-form" onSubmit={submit}>
              <label htmlFor="email" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Email address</label>
              <input id="email" className="dx-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
              <button type="submit" className="dx-btn dx-btn--solid">Get early access</button>
            </form>
          )}
        </div>
      </section>

      <footer className="dx-footer">
        <div className="dx-wrap dx-footer-in">
          <div className="dx-footer-brand">
            <Logo />
            <small>© {new Date().getFullYear()} DIY Sandbox</small>
          </div>
          <ul>{["Masterclasses", "Privacy", "Terms", "Contact"].map((l) => <li key={l}><a href="#">{l}</a></li>)}</ul>
          <ul className="dx-socials">{["X", "YouTube", "Discord"].map((s) => <li key={s}><a href="#" aria-label={s}>{s}</a></li>)}</ul>
        </div>
      </footer>
    </>
  );
}

/* The display font is a nicety, not a dependency: it is attached after mount so a slow
   or unreachable Google Fonts never delays the page. The CSS stack falls back cleanly. */
function useDisplayFont() {
  useEffect(() => {
    const href =
      "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&display=swap";
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }, []);
}

export default function LandingPage() {
  const [active, setActive] = useState<VehicleId | null>(null);
  useDisplayFont();
  return (
    <div className="theme-root">
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      {active ? (
        <InteractiveWorkspace vehicleId={active} onExit={() => setActive(null)} />
      ) : (
        <main className="dx-page">
          <div className="dx-bg dx-bg-grid" aria-hidden />
          <div className="dx-bg dx-bg-glow" aria-hidden />
          <div className="dx-bg dx-bg-ember" aria-hidden />
          <Nav onLaunch={setActive} />
          <Hero onLaunch={setActive} />
          <Catalog onLaunch={setActive} />
          <Method />
          <HardwareBridge />
          <CTAAndFooter />
          <div className="dx-fab">
            <span className="dx-ping" aria-hidden />
            <button className="dx-fab-btn" onClick={() => setActive("car")} aria-label="Open the sandbox" title="Open the sandbox"><Hammer size={28} /></button>
          </div>
        </main>
      )}
    </div>
  );
}
