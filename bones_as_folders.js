/*
 * Bones as Folders for Blockbench 5.2+
 *
 * Lets meshes and cubes sit inside armature bones in the outliner, so bones double as folders.
 *
 * Meshes inside a bone stay normal skinned meshes of that bone's armature:
 *  - dropped into a bone with no weights yet, every point is auto-painted to that bone (weight 1), so the
 *    part follows it straight away (same undo step as the drag);
 *  - repaint any points you like in place (Weight Brush, Set Vertex Weights), e.g. the back of an eyelid to
 *    the head bone so only the front moves. Existing weights are never wiped by moving a part between folders;
 *    right-click ▸ Reset Weights to Folder Bone starts over;
 *  - export as ordinary skinned meshes on the armature's skeleton.
 * Cubes can't hold weights, so a cube inside a bone is rigidly attached to it instead (exported as a mesh node
 * under the joint).
 *
 * Findings in Blockbench 5.2.2 that this relies on:
 * - Drop rules are data: ArmatureBone.behavior.child_types (['armature_bone','locator','null_object']).
 * - .bbmodel loading (Outliner.loadJSON) doesn't check types, so the tree saves and reloads as is.
 * - Weights live on the bones (vertex_weights, keyed meshuuid[0:6]:vkey). Every weight tool, the Animate
 *   preview (Armature.calculateVertexDeformation) and weight display find a mesh's armature via
 *   Mesh.getArmature(), which only looks at the direct parent; this plugin makes it look through bones.
 * - Deformation uses the mesh's rest position under the armature, so a skinned mesh inside a bone has to hang
 *   on the armature's 3D object, not the bone's, or it would move twice. The plugin does that on every
 *   'update_transform'.
 * - Export: Codecs.gltf.compile skins only the armature's direct children (buildSkinnedMesh) and leaves the
 *   live armature out. While a glTF export runs, the plugin adds the bone-folder meshes to the export as
 *   skinned meshes on the same skeleton (built the same way as buildSkinnedMesh), and hangs cubes on the
 *   export bones, inside GLTFExporter.parse only, then removes them again.
 *
 * The helpers above "Blockbench layer" have no Blockbench dependencies, for Node tests.
 */
(function () {
	'use strict';

	const PLUGIN_ID = 'bones_as_folders';
	const CHILD_TYPES = ['mesh', 'cube'];

	// ---------------------------------------------------------------- weights

	const weightKey = (meshUuid, vkey) => meshUuid.substring(0, 6) + ':' + vkey;

	/** Does any bone hold a weight for this mesh? bones: [{vertex_weights}] */
	function meshHasWeights(meshUuid, vkeys, bones) {
		const prefix = meshUuid.substring(0, 6) + ':';
		return bones.some(b => Object.keys(b.vertex_weights || {}).some(k => k.startsWith(prefix) && b.vertex_weights[k] > 0));
	}

	/** Weight 1 on `bone` for every point, removing this mesh's weights from all other bones. */
	function paintFull(meshUuid, vkeys, bone, allBones) {
		const prefix = meshUuid.substring(0, 6) + ':';
		for (const b of allBones) {
			for (const k of Object.keys(b.vertex_weights || {})) if (k.startsWith(prefix)) delete b.vertex_weights[k];
		}
		if (!bone.vertex_weights) bone.vertex_weights = {};
		for (const vk of vkeys) bone.vertex_weights[weightKey(meshUuid, vk)] = 1;
	}

	/**
	 * skinIndex / skinWeight arrays in the same order Blockbench's buildSkinnedMesh writes them
	 * (faces in order, face.vertices in order, faces with 3+ points). getWeight(bone, vkey); boneIndex(bone).
	 */
	function skinAttributes(faces, bones, getWeight, boneIndex) {
		const skinIndices = [], skinWeights = [];
		for (const key in faces) {
			const face = faces[key];
			if (face.vertices.length < 3) continue;
			for (const vkey of face.vertices) {
				const influencing = bones.filter(b => getWeight(b, vkey))
					.sort((a, b) => getWeight(b, vkey) - getWeight(a, vkey)).slice(0, 4);
				const sum = influencing.reduce((s, b) => s + getWeight(b, vkey), 0);
				for (let i = 0; i < 4; i++) {
					if (influencing[i]) { skinIndices.push(boneIndex(influencing[i])); skinWeights.push(getWeight(influencing[i], vkey) / sum); }
					else { skinIndices.push(0); skinWeights.push(0); }
				}
			}
		}
		return { skinIndices, skinWeights };
	}

	// ---------------------------------------------------------------- matrices (column-major, like THREE), for cubes

	const DEG = Math.PI / 180;
	function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
	function multiply(a, b) {
		const o = new Array(16);
		for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
			o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
		}
		return o;
	}
	function axisRotation(axis, deg) {
		const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), m = identity();
		if (axis === 'X') { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
		if (axis === 'Y') { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
		if (axis === 'Z') { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
		return m;
	}
	function eulerMatrix(rot, order) {
		const idx = { X: 0, Y: 1, Z: 2 };
		let m = identity();
		for (const a of order || 'XYZ') m = multiply(m, axisRotation(a, rot[idx[a]] || 0));
		return m;
	}
	function compose(pos, rot, order, scale) {
		const m = eulerMatrix(rot, order);
		const s = scale || [1, 1, 1];
		for (let r = 0; r < 3; r++) { m[r] *= s[0]; m[4 + r] *= s[1]; m[8 + r] *= s[2]; }
		m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
		return m;
	}
	function invertRigid(m) {
		const o = identity();
		for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
		for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
		return o;
	}
	function apply(m, p) {
		return [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
	}
	function boneRestMatrix(chain, order) {
		let m = identity();
		for (const b of chain) m = multiply(m, compose(b.origin, b.rotation, order));
		return m;
	}
	function localUnderBone(boneRest, partModel) {
		return multiply(invertRigid(boneRest), partModel);
	}

	const core = {
		weightKey, meshHasWeights, paintFull, skinAttributes,
		identity, multiply, compose, eulerMatrix, invertRigid, apply, boneRestMatrix, localUnderBone, CHILD_TYPES,
	};

	// Outside Blockbench (Node tests) export the core and stop here.
	if (typeof Plugin === 'undefined' || typeof BARS === 'undefined') {
		if (typeof module === 'object' && module && module.exports) module.exports = core;
		return;
	}

	// ================================================================ Blockbench layer

	let active = false;
	let addedTypes = [];
	let origGetArmature = null, patchedGetArmature = null;
	let origParse = null, wrappedParse = null;
	let origCompile = null, wrappedCompile = null;
	let exporting = 0;
	const controllerListeners = [];
	let resetAction = null;
	let isolateAction = null, origIsolateClick = null, wrappedIsolateClick = null;

	/** Everything inside the selected bones (parts and child bones), like the contents of a selected folder. */
	function contentsOfSelectedBones() {
		const out = new Set();
		const walk = node => {
			for (const child of node.children || []) {
				if (typeof child !== 'object') continue;
				out.add(child);
				walk(child);
			}
		};
		const selected = typeof Outliner !== 'undefined' ? Outliner.selected : [];
		for (const el of selected) {
			if (el instanceof ArmatureBone) walk(el);
		}
		// Parents too (bones above, the armature): in the 3D scene a hidden bone or armature hides everything
		// hanging under it, whatever the outliner's eye icons say.
		for (const el of [...selected, ...out]) {
			for (let p = el.parent; p && typeof p === 'object'; p = p.parent) {
				if (p instanceof ArmatureBone || (typeof Armature !== 'undefined' && p instanceof Armature)) out.add(p);
			}
		}
		return [...out].filter(el => !el.selected);
	}

	const inBone = el => typeof ArmatureBone !== 'undefined' && el && el.parent instanceof ArmatureBone;
	const folderArmature = el => (inBone(el) ? el.parent.getArmature() : undefined);

	function boneChain(bone) {
		const chain = [];
		for (let b = bone; b instanceof ArmatureBone; b = b.parent) chain.unshift({ origin: b.origin, rotation: b.rotation });
		return chain;
	}

	// ---- preview placement
	function onUpdateTransform({ element }) {
		if (!active || !inBone(element) || !element.mesh) return;
		const obj = element.mesh;
		if (element instanceof Mesh) {
			// Skinned: hang on the armature at its model-space spot; the weights do the moving.
			const armature = folderArmature(element);
			if (!armature || !armature.mesh) return;
			armature.mesh.add(obj);
			obj.position.set(element.origin[0], element.origin[1], element.origin[2]);
			obj.updateMatrixWorld();
		} else {
			// Cube: rigidly attached to the bone, at its modelled spot relative to the bone's rest pose.
			const rest = boneRestMatrix(boneChain(element.parent), Format.euler_order || 'XYZ');
			const model = compose(element.origin, element.rotation, obj.rotation.order, [obj.scale.x, obj.scale.y, obj.scale.z]);
			new THREE.Matrix4().fromArray(localUnderBone(rest, model)).decompose(obj.position, obj.quaternion, obj.scale);
			obj.updateMatrixWorld();
		}
	}

	// ---- auto-paint
	function unweightedFolderMeshes() {
		return Mesh.all.filter(m => {
			const arm = folderArmature(m);
			return arm && !meshHasWeights(m.uuid, Object.keys(m.vertices), arm.getAllBones());
		});
	}
	function autoPaint(meshes) {
		for (const m of meshes) {
			paintFull(m.uuid, Object.keys(m.vertices), m.parent, folderArmature(m).getAllBones());
			if (m.preview_controller) m.preview_controller.updateGeometry(m);
		}
	}
	/** Runs inside Undo.finishEdit, before the "after" state is saved, so the paint is part of the same step. */
	function onFinishEdit({ aspects }) {
		if (!active || !aspects) return;
		const meshes = unweightedFolderMeshes();
		if (!meshes.length) return;
		const bones = [...new Set(meshes.flatMap(m => folderArmature(m).getAllBones()))];
		aspects.elements = (aspects.elements || []).slice();
		for (const b of bones) if (!aspects.elements.includes(b)) aspects.elements.push(b);
		if (Undo.current_save) Undo.current_save.addElements(bones, aspects); // their "before" state
		autoPaint(meshes);
	}
	/** Projects opened with parts already in bones but no weights (e.g. from 1.0). */
	function autoPaintOnLoad() {
		const meshes = unweightedFolderMeshes();
		if (!meshes.length) return;
		autoPaint(meshes);
		if (typeof Project !== 'undefined' && Project) Project.saved = false;
	}

	function resetWeights() {
		const meshes = Mesh.selected.filter(inBone);
		if (!meshes.length) { Blockbench.showQuickMessage('Select meshes that are inside a bone', 2000); return; }
		const bones = [...new Set(meshes.flatMap(m => folderArmature(m).getAllBones()))];
		Undo.initEdit({ elements: [...meshes, ...bones] });
		autoPaint(meshes);
		Undo.finishEdit('Reset weights to folder bone');
	}

	// ---- export
	function exportExtras(scene) {
		const added = [], moved = [];
		const exportBones = {};
		scene.traverse(o => { if (o.isBone) exportBones[o.uuid] = o; });

		// Skinned meshes inside bones → extra SkinnedMeshes on the armature's export skeleton.
		const byArmature = new Map();
		for (const m of Mesh.all) {
			const arm = folderArmature(m);
			if (!arm || m.export === false || !m.faces || !m.mesh) continue;
			if (!byArmature.has(arm)) byArmature.set(arm, []);
			byArmature.get(arm).push(m);
		}
		for (const [arm, meshes] of byArmature) {
			const armBones = arm.getAllBones();
			const bones = armBones.map(b => exportBones[b.mesh && b.mesh.uuid]);
			if (bones.some(b => !b) || !bones.length) continue;
			// The export group: the parent of the export root bones.
			let group = bones[0];
			while (group.parent && group.parent.isBone) group = group.parent;
			group = group.parent;
			if (!group) continue;
			let skeleton = null;
			group.traverse(o => { if (!skeleton && o.isSkinnedMesh && o.skeleton) skeleton = o.skeleton; });
			if (!skeleton) { group.updateMatrixWorld(true); skeleton = new THREE.Skeleton(bones); }
			const index = b => skeleton.bones.indexOf(exportBones[b.mesh.uuid]);
			for (const m of meshes) {
				m.mesh.updateMatrix();
				const geometry = m.mesh.geometry.clone();
				geometry.applyMatrix4(m.mesh.matrix);
				const { skinIndices, skinWeights } = skinAttributes(m.faces, armBones, (b, vk) => b.getVertexWeight(m, vk), index);
				geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
				geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
				const skinned = new THREE.SkinnedMesh(geometry, m.mesh.material);
				skinned.name = m.name;
				group.add(skinned);
				skinned.bind(skeleton);
				added.push([group, skinned]);
			}
		}

		// Cubes inside bones → rigid, hung on the export bone.
		for (const c of Cube.all) {
			if (!inBone(c) || c.export === false || !c.mesh) continue;
			const target = exportBones[c.parent.mesh && c.parent.mesh.uuid];
			if (!target) continue;
			moved.push([c.mesh, c.mesh.parent]);
			target.add(c.mesh);
		}
		return () => {
			for (const [g, s] of added) g.remove(s);
			for (const [obj, parent] of moved.reverse()) if (parent) parent.add(obj);
		};
	}

	Plugin.register(PLUGIN_ID, {
		title: 'Bones as Folders',
		author: 'yarrbeard-gyps',
		description: 'Put meshes inside armature bones: auto-weighted to that bone, repaintable in place, exported as normal skinned meshes.',
		icon: 'account_tree',
		version: '1.1.1',
		variant: 'both',
		min_version: '5.2.0',
		tags: ['Rigging', 'Outliner', 'Exporter'],
		onload() {
			if (typeof ArmatureBone === 'undefined' || typeof Armature === 'undefined') {
				console.warn('[Bones as Folders] Armatures not found; this needs Blockbench 5.2+');
				return;
			}
			active = true;

			// Outliner: allow meshes and cubes inside bones.
			const types = ArmatureBone.behavior.child_types;
			for (const t of CHILD_TYPES) if (!types.includes(t)) { types.push(t); addedTypes.push(t); }

			// Weight tools, deformation and weight display: a mesh inside a bone belongs to that armature.
			origGetArmature = Mesh.prototype.getArmature;
			patchedGetArmature = function () {
				if (active && this.parent instanceof ArmatureBone) return this.parent.getArmature();
				return origGetArmature.call(this);
			};
			Mesh.prototype.getArmature = patchedGetArmature;

			// Preview placement.
			for (const type of [Mesh, Cube]) {
				const ctrl = type.preview_controller;
				if (!ctrl) continue;
				ctrl.on('update_transform', onUpdateTransform);
				controllerListeners.push(ctrl);
			}

			// Auto-paint on drop (inside the same undo step), and for projects opened later.
			Blockbench.on('finish_edit', onFinishEdit);
			Blockbench.on('load_project', autoPaintOnLoad);

			// Export.
			origParse = THREE.GLTFExporter.prototype.parse;
			wrappedParse = function (input, onDone, options) {
				if (!active || !exporting || !input || !input.traverse) return origParse.call(this, input, onDone, options);
				let cleanup = () => {};
				try { cleanup = exportExtras(input); } catch (err) { console.warn('[Bones as Folders] export failed to add folder parts', err); }
				const done = result => { cleanup(); onDone(result); };
				try { return origParse.call(this, input, done, options); }
				catch (err) { cleanup(); throw err; }
			};
			THREE.GLTFExporter.prototype.parse = wrappedParse;
			const codec = Codecs.gltf;
			if (codec) {
				origCompile = codec.compile;
				wrappedCompile = async function () {
					exporting++;
					try { return await origCompile.apply(this, arguments); }
					finally { exporting--; }
				};
				codec.compile = wrappedCompile;
			}

			resetAction = new Action('reset_weights_to_folder_bone', {
				name: 'Reset Weights to Folder Bone',
				description: 'Weight every point of the selected meshes fully to the bone they sit in',
				icon: 'account_tree',
				category: 'edit',
				condition: { modes: ['edit'], method: () => Mesh.selected.some(inBone) },
				click: resetWeights,
			});
			if (Mesh.prototype.menu) Mesh.prototype.menu.addAction(resetAction, '#mesh_edit');

			// View ▸ Hide Everything Except Selection (I): a selected bone keeps its contents visible.
			isolateAction = typeof BarItems !== 'undefined' && BarItems.hide_everything_except_selection;
			if (isolateAction && typeof isolateAction.click === 'function') {
				origIsolateClick = isolateAction.click;
				wrappedIsolateClick = function () {
					// Only when hiding (not when un-hiding). Mark the contents as selected just for the original
					// click, which hides every unselected element, then put the flags back.
					const extra = active && !(Project && Project.only_hidden_elements) ? contentsOfSelectedBones() : [];
					extra.forEach(el => { el.selected = true; });
					try { return origIsolateClick.apply(this, arguments); }
					finally { extra.forEach(el => { el.selected = false; }); }
				};
				isolateAction.click = wrappedIsolateClick;
			}

			refreshAll();
			autoPaintOnLoad();
		},
		onunload() {
			active = false;
			const types = ArmatureBone && ArmatureBone.behavior && ArmatureBone.behavior.child_types;
			if (types) for (const t of addedTypes) types.remove(t);
			addedTypes = [];
			if (Mesh.prototype.getArmature === patchedGetArmature) Mesh.prototype.getArmature = origGetArmature;
			for (const ctrl of controllerListeners) ctrl.removeListener('update_transform', onUpdateTransform);
			controllerListeners.length = 0;
			Blockbench.removeListener('finish_edit', onFinishEdit);
			Blockbench.removeListener('load_project', autoPaintOnLoad);
			if (THREE.GLTFExporter.prototype.parse === wrappedParse) THREE.GLTFExporter.prototype.parse = origParse;
			if (Codecs.gltf && Codecs.gltf.compile === wrappedCompile) Codecs.gltf.compile = origCompile;
			if (resetAction) {
				if (Mesh.prototype.menu && Array.isArray(Mesh.prototype.menu.structure)) Mesh.prototype.menu.structure.remove(resetAction);
				resetAction.delete();
			}
			resetAction = null;
			if (isolateAction && isolateAction.click === wrappedIsolateClick) isolateAction.click = origIsolateClick;
			isolateAction = null;
			refreshAll();
		},
	});

	function refreshAll() {
		for (const el of [...Mesh.all, ...Cube.all]) {
			if (inBone(el) && el.preview_controller) {
				try { el.preview_controller.updateTransform(el); } catch (err) { /* ignore */ }
			}
		}
	}
})();
