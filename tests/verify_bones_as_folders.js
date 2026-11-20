// Offline checks for bones_as_folders.js. Run: node tests/verify_bones_as_folders.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const FILE = path.resolve(__dirname, '..', 'bones_as_folders.js');
let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; console.log('ok  ' + msg); };
const nearArr = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);
const C = require(FILE);

// ---- core: weights
const head = { name: 'head', vertex_weights: {} }, lid = { name: 'lid_l', vertex_weights: { 'abcdef:x': 1 } };
ok(!C.meshHasWeights('123456-mesh', ['a'], [head, lid]) && C.meshHasWeights('abcdef-other', [], [head, lid]), 'detects whether a mesh has any weights');
head.vertex_weights['123456:a'] = 0.5;
C.paintFull('123456-mesh', ['a', 'b'], lid, [head, lid]);
ok(!('123456:a' in head.vertex_weights) && lid.vertex_weights['123456:a'] === 1 && lid.vertex_weights['123456:b'] === 1 && lid.vertex_weights['abcdef:x'] === 1, 'paintFull: weight 1 on the folder bone, other bones cleared for this mesh only');

// skin attributes: back points to head, front to lid, a middle point split 50/50
const faces = { f: { vertices: ['back', 'mid', 'front'] }, line: { vertices: ['back', 'front'] } };
const w = { head: { back: 1, mid: 0.5 }, lid: { mid: 0.5, front: 1 } };
const bonesList = [{ n: 'head' }, { n: 'lid' }];
const { skinIndices, skinWeights } = C.skinAttributes(faces, bonesList, (b, vk) => w[b.n][vk] || 0, b => bonesList.indexOf(b));
ok(skinIndices.length === 12 && skinWeights.length === 12, 'one 4-slot entry per face point (2-point faces skipped, like Blockbench)');
ok(nearArr(skinWeights.slice(0, 4), [1, 0, 0, 0]) && skinIndices[0] === 0, 'back point: fully on head');
ok(nearArr(skinWeights.slice(4, 8), [0.5, 0.5, 0, 0]), 'middle point: split');
ok(nearArr(skinWeights.slice(8, 12), [1, 0, 0, 0]) && skinIndices[8] === 1, 'front point: fully on the lid');

// ---- core: rigid cube maths
const chain = [{ origin: [0, 10, 0], rotation: [0, 0, 0] }, { origin: [3, 2, 0], rotation: [0, 0, 30] }];
const rest = C.boneRestMatrix(chain, 'ZYX');
const cubeModel = C.compose([4, 13, 1], [10, 20, 0], 'XYZ');
ok(nearArr(C.multiply(rest, C.localUnderBone(rest, cubeModel)), cubeModel), 'cube under a rotated bone keeps its exact place');

// ---- mock THREE + Blockbench
function quatFromMatrix(m) {
	const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10], t = m11 + m22 + m33;
	if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); return { w: 0.25 / s, x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s }; }
	if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return { w: (m32 - m23) / s, x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s }; }
	if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return { w: (m13 - m31) / s, x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s }; }
	const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return { w: (m21 - m12) / s, x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s };
}
function matFromTRS(p, q, s) {
	const { x, y, z, w } = q, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
	return [(1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0, (xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0, (xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0, p.x, p.y, p.z, 1];
}
const vec = () => ({ x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } });
class Obj3D {
	constructor(name) { this.name = name; this.uuid = 'u' + Math.random(); this.children = []; this.parent = null; this.position = vec(); this.quaternion = { x: 0, y: 0, z: 0, w: 1 }; this.scale = Object.assign(vec(), { x: 1, y: 1, z: 1 }); this.rotation = { order: 'XYZ' }; this.matrix = 'M:' + name; }
	add(o) { if (o.parent) o.parent.remove(o); o.parent = this; this.children.push(o); }
	remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; }
	traverse(f) { f(this); this.children.slice().forEach(c => c.traverse(f)); }
	updateMatrixWorld() {} updateMatrix() {}
}
const THREE = {
	Matrix4: class { fromArray(a) { this.e = a; return this; } decompose(p, q, s) {
		const e = this.e, sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
		Object.assign(p, { x: e[12], y: e[13], z: e[14] }); Object.assign(s, { x: sx, y: sy, z: sz });
		const r = e.slice(); [0, 1, 2].forEach(i => { r[i] /= sx; r[4 + i] /= sy; r[8 + i] /= sz; }); Object.assign(q, quatFromMatrix(r));
	} },
	Skeleton: class { constructor(bones) { this.bones = bones; } },
	SkinnedMesh: class extends Obj3D { constructor(geo, mat) { super('skinned'); this.geometry = geo; this.material = mat; this.isSkinnedMesh = true; } bind(s) { this.skeleton = s; } },
	Uint16BufferAttribute: class { constructor(a) { this.array = a; } },
	Float32BufferAttribute: class { constructor(a) { this.array = a; } },
	GLTFExporter: function () {},
};
let atParse = null;
THREE.GLTFExporter.prototype.parse = function (input, onDone) {
	atParse = { skinned: [], cubeParent: nail.mesh.parent };
	input.traverse(o => { if (o.isSkinnedMesh && o.name !== 'existing') atParse.skinned.push(o); });
	onDone('glb');
};

const bbEvents = {}, ctrlListeners = { mesh: [], cube: [] };
const mkCtrl = key => ({
	on: (e, f) => ctrlListeners[key].push(f), removeListener: (e, f) => { ctrlListeners[key] = ctrlListeners[key].filter(x => x !== f); },
	updateTransform(el) { el.mesh.position.set(...el.origin); el.parent.mesh.add(el.mesh); ctrlListeners[key].forEach(f => f({ element: el })); },
	updateGeometry(el) { el.geoUpdates = (el.geoUpdates || 0) + 1; },
});
class Armature { constructor() { this.name = 'armature'; this.children = []; this.mesh = new Obj3D('armature'); } getAllBones() { return ArmatureBone.all; } }
class ArmatureBone {
	constructor(name, origin, rotation, parent) { Object.assign(this, { name, origin, rotation, parent, children: [], vertex_weights: {} }); this.uuid = name + '-uuid'; this.mesh = new Obj3D(name); parent.children.push(this); }
	getArmature() { let p = this.parent; while (p instanceof ArmatureBone) p = p.parent; return p; }
	getVertexWeight(mesh, vk) { return this.vertex_weights[C.weightKey(mesh.uuid, vk)] || 0; }
}
ArmatureBone.behavior = { child_types: ['armature_bone', 'locator', 'null_object'] };
class Mesh {
	constructor(name, uuid, origin, parent) { Object.assign(this, { name, uuid, origin, parent, rotation: [0, 0, 0], export: true }); parent.children.push(this); this.mesh = new Obj3D(name); this.mesh.geometry = { clone() { return { attrs: {}, applyMatrix4(m) { this.m = m; }, setAttribute(k, v) { this.attrs[k] = v; } }; } }; this.preview_controller = Mesh.preview_controller;
		this.vertices = { back: [0, 0, 0], front: [0, 0, 1] }; this.faces = { f: { vertices: ['back', 'front', 'back'] } }; }
	getArmature() { return this.parent instanceof Armature ? this.parent : undefined; }
}
class Cube { constructor(name, origin, rotation, parent) { Object.assign(this, { name, origin, rotation, parent, export: true }); parent.children.push(this); this.mesh = new Obj3D(name); this.preview_controller = Cube.preview_controller; } }
Mesh.preview_controller = mkCtrl('mesh'); Cube.preview_controller = mkCtrl('cube');
const armature = new Armature();
const headB = new ArmatureBone('head', [0, 10, 0], [0, 0, 0], armature);
const lidB = new ArmatureBone('lid_l', [3, 2, 0], [0, 0, 30], headB);
ArmatureBone.all = [headB, lidB];
const eyelid = new Mesh('eyelid_l', 'eyelid-0001', [4, 13, 1], lidB);
const body = new Mesh('body', 'body00-0002', [0, 0, 0], armature);
const nail = new Cube('nail', [4, 13, 1], [10, 20, 0], lidB);
Mesh.all = [eyelid, body]; Mesh.selected = []; Cube.all = [nail];
const menu = { structure: [], addAction(a) { this.structure.push(a); } };
Mesh.prototype.menu = menu;
let registered, action, undoLog = [];
const save = { addElements(els) { undoLog.push(['before', els.map(b => JSON.stringify(b.vertex_weights))]); } };
const codec = { compile: async function () {
	const scene = new Obj3D('scene'), group = new Obj3D('armature_export'); scene.add(group);
	const eh = new Obj3D('head_x'); eh.isBone = true; eh.uuid = headB.mesh.uuid; group.add(eh);
	const el = new Obj3D('lid_x'); el.isBone = true; el.uuid = lidB.mesh.uuid; eh.add(el);
	const existing = new THREE.SkinnedMesh({}, null); existing.name = 'existing'; existing.skeleton = new THREE.Skeleton([eh, el]); group.add(existing);
	this.exportLid = el; this.group = group;
	return new Promise(res => new THREE.GLTFExporter().parse(scene, res, {}));
} };
const ctx = {
	Plugin: { register: (id, o) => { registered = { id, o }; } }, BARS: {}, THREE, Armature, ArmatureBone, Mesh, Cube, Format: { euler_order: 'ZYX' },
	Codecs: { gltf: codec }, Project: { saved: true },
	Outliner: { selected: [] },
	BarItems: { hide_everything_except_selection: { click() { // like Blockbench: hide every unselected element, or undo that
		const all = [armature, ...ArmatureBone.all, ...Mesh.all, ...Cube.all];
		if (ctx.Project.only_hidden_elements) { all.forEach(e => { e.visibility = true; }); delete ctx.Project.only_hidden_elements; }
		else { const hid = all.filter(e => !e.selected); hid.forEach(e => { e.visibility = false; }); ctx.Project.only_hidden_elements = hid; }
	} } },
	Undo: { current_save: null, initEdit(a) { undoLog.push(['init', a]); }, finishEdit(m) { undoLog.push(['finish', m]); } },
	Blockbench: { on: (e, f) => { (bbEvents[e] = bbEvents[e] || []).push(f); }, removeListener: (e, f) => { bbEvents[e] = bbEvents[e].filter(x => x !== f); }, showQuickMessage() {} },
	Action: class { constructor(id, o) { action = this; Object.assign(this, o); } delete() { this.deleted = true; } },
};
Array.prototype.remove = function (x) { const i = this.indexOf(x); if (i >= 0) this.splice(i, 1); };
new Function(...Object.keys(ctx), fs.readFileSync(FILE, 'utf8'))(...Object.values(ctx));
const origParse = THREE.GLTFExporter.prototype.parse, origCompile = codec.compile, origGetArm = Mesh.prototype.getArmature;
registered.o.onload();

(async () => {
	ok(['mesh', 'cube'].every(t => ArmatureBone.behavior.child_types.includes(t)), 'outliner accepts meshes and cubes inside bones');
	ok(eyelid.getArmature() === armature && body.getArmature() === armature, 'a mesh inside a bone belongs to the armature (weight tools appear)');
	ok(lidB.vertex_weights['eyelid:back'] === 1 && ctx.Project.saved === false, 'on load: unweighted mesh in a bone is auto-painted to it');

	// Preview: skinned mesh hangs on the armature at its model-space spot; the cube on the bone.
	Mesh.preview_controller.updateTransform(eyelid);
	ok(eyelid.mesh.parent === armature.mesh && eyelid.mesh.position.x === 4 && eyelid.mesh.position.y === 13, 'mesh in a bone hangs on the armature (weights move it, no double transform)');
	Cube.preview_controller.updateTransform(nail);
	Cube.preview_controller.updateTransform(nail);
	const o = nail.mesh;
	ok(o.parent === lidB.mesh && nearArr(C.multiply(rest, matFromTRS(o.position, o.quaternion, o.scale)), cubeModel), 'cube in a bone: rigid on the bone, exact place, no drift');

	// Drop a new unweighted mesh into the lid: auto-paint inside the same undo step.
	const lash = new Mesh('lash_l', 'lash00-0003', [4, 13, 2], lidB); Mesh.all.push(lash);
	ctx.Undo.current_save = save; undoLog = [];
	const aspects = { outliner: true };
	bbEvents.finish_edit.forEach(f => f({ aspects }));
	ok(lidB.vertex_weights['lash00:back'] === 1 && lidB.vertex_weights['lash00:front'] === 1, 'dropped mesh auto-painted fully to its folder bone');
	ok(aspects.elements.includes(lidB) && aspects.elements.includes(headB) && undoLog[0][0] === 'before' && !undoLog[0][1].some(s => s.includes('lash00')), 'bones added to the undo step with their before-state (one Ctrl+Z)');

	// Repaint: back of the eyelid to head. Further edits must not wipe it.
	headB.vertex_weights['eyelid:back'] = 1; delete lidB.vertex_weights['eyelid:back'];
	bbEvents.finish_edit.forEach(f => f({ aspects: {} }));
	ok(headB.vertex_weights['eyelid:back'] === 1 && !lidB.vertex_weights['eyelid:back'], 'your repainted weights are kept');

	// Export: eyelid becomes an extra skinned mesh on the existing skeleton; cube hangs on the export bone.
	await codec.compile();
	const sk = atParse.skinned.find(s => s.name === 'eyelid_l');
	ok(sk && sk.skeleton === codec.group.children.find(c => c.name === 'existing').skeleton, 'export: folder mesh skinned on the armature\'s skeleton');
	ok(nearArr(sk.geometry.attrs.skinWeight.array.slice(0, 4), [1, 0, 0, 0]) && sk.geometry.attrs.skinIndex.array[0] === 0 && sk.geometry.attrs.skinIndex.array[4] === 1, 'export weights: back → head (index 0), front → lid (index 1)');
	ok(sk.geometry.m === eyelid.mesh.matrix, 'geometry placed with the mesh\'s own matrix, as Blockbench does');
	ok(atParse.cubeParent === codec.exportLid && nail.mesh.parent === lidB.mesh, 'cube on the export bone during export, back afterwards');
	ok(!codec.group.children.some(c => c.name === 'eyelid_l'), 'export extras removed afterwards');
	eyelid.export = false; await codec.compile();
	ok(!atParse.skinned.some(s => s.name === 'eyelid_l'), 'Export off respected');
	eyelid.export = true;

	// Reset action.
	Mesh.selected = [eyelid]; undoLog = [];
	action.click();
	ok(lidB.vertex_weights['eyelid:back'] === 1 && !headB.vertex_weights['eyelid:back'] && undoLog[0][1].elements.includes(headB) && undoLog[1][1] === 'Reset weights to folder bone', 'Reset Weights to Folder Bone: full weight, one undo step');

	// Hide Everything Except Selection with only the lid bone selected: its contents stay visible.
	[armature, ...ArmatureBone.all, ...Mesh.all, ...Cube.all].forEach(e => { e.visibility = true; e.selected = false; });
	lidB.selected = true; ctx.Outliner.selected = [lidB];
	ctx.BarItems.hide_everything_except_selection.click();
	ok(eyelid.visibility === true && nail.visibility === true && lidB.visibility === true, 'isolating a bone keeps the parts inside it visible');
	ok(headB.visibility === true && armature.visibility === true, "parents (head bone, armature) stay visible, so Blockbench's scene doesn't hide the lid with them");
	ok(body.visibility === false, 'everything else is hidden');
	ok(eyelid.selected === false && nail.selected === false && headB.selected === false && armature.selected === false, 'selection left as it was');
	ctx.BarItems.hide_everything_except_selection.click();
	ok([headB, body, eyelid].every(e => e.visibility === true), 'pressing it again shows everything');

	registered.o.onunload();
	ok(Mesh.prototype.getArmature === origGetArm && THREE.GLTFExporter.prototype.parse === origParse && codec.compile === origCompile
		&& !ArmatureBone.behavior.child_types.includes('mesh') && !bbEvents.finish_edit.length && !ctrlListeners.mesh.length && action.deleted, 'unload restores everything');
	console.log(`\n${pass} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
