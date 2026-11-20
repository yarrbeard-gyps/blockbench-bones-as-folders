# Bones as Folders for Blockbench

A Blockbench 5.2+ plugin that lets you put **meshes (and cubes) inside armature bones** in the outliner, so the
bones double as folders and the outliner stays organised the way you model.

Without it, Blockbench refuses to drop a mesh onto a bone. Every part then sits in one flat list under the
armature, since vertex weights only work there.

## The folder is the default weight
- **Drop a mesh into a bone, and it's auto-painted:** every point gets weight 1 on that bone. The part follows the
  bone straight away. Legs, eyes and teeth are done at this point. Undoing the drag also undoes the paint.
- **Repaint in place** to make a part bend, without taking it out of its folder. Use the Weight Brush, Set Vertex
  Weights or Calculate Vertex Weights. Example: paint the back of an eyelid to `head`, and only the front around
  the eye moves with `lid_l`.
- **Your painting is never wiped** by moving a part to another folder. To start over, right-click the mesh ▸
  **Reset Weights to Folder Bone**.
- **Meshes directly under the armature** work exactly as before.

Every mesh stays an ordinary skinned mesh, so the glTF export is normal skinning on one skeleton. Godot imports it
as a Skeleton3D with skinned meshes.

**View ▸ Hide Everything Except Selection (I)** treats a selected bone like a folder. Everything inside it stays
visible, and so do its parent bones and the armature. Otherwise Blockbench's 3D scene would hide the selected bone
along with its hidden parents, even with its eye icon on.

**Cubes** can't hold weights, so a cube inside a bone is rigidly attached to it instead. It follows the bone
exactly and exports as a mesh on that joint.

## Install
**File ▸ Plugins ▸ Load Plugin from File**, then pick [`bones_as_folders.js`](bones_as_folders.js) (optionally keep
`about.md` next to it).

## How it works (Blockbench 5.2.2)
- **Outliner:** which parents accept which children is plain data (`ArmatureBone.behavior.child_types`); the plugin
  adds `mesh` and `cube`.
- **Saving:** `.bbmodel` saving keeps the tree as is, and loading doesn't check types, so parts stay in their bones.
- **Weights:** they live on the bones. Every weight tool, the Animate preview and the weight view find a mesh's
  armature through `Mesh.getArmature()`, which only looks at the direct parent. The plugin makes it look through
  bones.
- **Preview:** a skinned mesh inside a bone hangs on the armature's 3D object, like a direct child, so only its
  weights move it, never twice.
- **Auto-paint:** it runs inside Blockbench's own undo step for the drag, with the bones' before-state added.
- **glTF export:** Blockbench skins only the armature's direct children. During a glTF export the plugin adds the
  folder meshes as extra skinned meshes on the same skeleton, built the same way as Blockbench's own, then removes
  them again.

## Without the plugin
The `.bbmodel` still opens, with parts in their bones and all weights kept. But Blockbench then shows those meshes
unskinned and at the wrong offset, and **glTF export leaves them out**. Keep the plugin installed for projects
that use it.

## Limits
- Groups can't go inside bones, only meshes and cubes.
- A mesh inside a bone with **no weights at all** is always auto-painted to its folder bone. To make a part not
  move, paint it to its parent bone instead.
- Assumes the armature sits at the model's origin, as it does by default.

## Tested
In Blockbench 5.2.2 on a real rig:
- meshes drop into bones and get auto-painted;
- repainting in place (with Weight Brush Plus) makes an eyelid hinge while its back follows the head;
- Hide Everything Except Selection keeps a bone's contents.

The glTF export into Godot is **not yet verified** in practice. Feedback welcome.

Offline: `node tests/verify_bones_as_folders.js` checks:
- weight detection and auto-paint;
- skin attributes ordered and normalised like Blockbench's export (back point on `head`, front on `lid`, split
  middle);
- that a cube inside a rotated bone keeps its place;
- against mocks of Blockbench:
  - the drop rule and the armature lookup through bones;
  - auto-paint on load and on drop, inside the same undo step, with repainted weights kept;
  - preview placement;
  - export as extra skinned meshes on the existing skeleton, with cubes on the export bones and everything
    removed afterwards;
  - Reset Weights to Folder Bone, and unload.

## Credits
Written with the help of an AI coding assistant (Claude). Issues and pull requests are welcome.

## License
[MIT](LICENSE)
