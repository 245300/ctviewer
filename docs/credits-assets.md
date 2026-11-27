## 场景与天光资产 / Scene & sky assets

车库外的城市与三档天光来自**本机 Unity 3D 赛车项目「天天赛车」**，不是公开仓库：

| 用途 | 原始文件（本地 Unity 工程内） | 本项目产物 |
| --- | --- | --- |
| 城市街区 | `Assets/CineMachines/Classical_city/Models/city.FBX` + `Textures/*.tif` | `assets/scenes/city/city.glb` |
| 日 / 阴 / 夜 天空 | `Assets/CineMachines/Classical_city/Textures/{day,overcast,night}_sky.hdr` | `assets/scenes/day_sky.hdr` 等 |
| 夜景窗光 | `building_a_light_night.tif` / `building_b_light.tif` / `banner_light.tif` | 烘焙进 GLB 的自发光贴图 |

> ⚠️ **许可边界**：`Classical_city` 是随该 Unity 工程取得的第三方素材包，原始许可未随文件声明。
> 因此这些城市 / 天空资产与本项目一样**仅限个人本地学习使用**，不得对外分发或商用。

## 车库材质与灯光资产 / Garage material & lighting assets

钢板地面与彩灯环境是 **CC0 1.0** 素材（可自由使用、修改、商用，无需署名；此处仍按两位作者 / 站点的惯例致谢）：

| 用途 | 素材 | 作者 / 来源 | 许可 |
| --- | --- | --- | --- |
| 花纹钢板地面（漫反射 / 法线 / 粗糙度 / 金属度 四张 1K JPG） | DiamondPlate008D | [ambientCG](https://ambientcg.com/view?id=DiamondPlate008D) · Lennart Demes | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| 彩灯环境反射（1K HDR，2:1 等距柱状） | neon_photostudio | [Poly Haven](https://polyhaven.com/a/neon_photostudio) · Sergej Majboroda | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

产物位置：`assets/scenes/garage/plate_{color,normal,rough,metal}.jpg`（1.1 MB）与 `assets/scenes/neon_studio.hdr`（1.6 MB）。

## 人物与动作资产 / Character & animation assets

| 用途 | 原始文件（本机 Unity 工程内） | 本项目产物 |
| --- | --- | --- |
| 10 位角色 | `Assets/8FastCars/少女前线2/少女前线2/<角色>/*.fbx` + `Textures/*.png` | `assets/characters/<id>.glb` |
| 15 段动作 | `Assets/Animations/charactor action/*.fbx`（Mixamo 动作） | `assets/characters/animations.glb` |

> ⚠️ **许可边界**：角色模型来自《少女前线 2：追放》游戏素材，动作来自 Mixamo，均未声明可再分发许可；
> 仅限个人本地学习使用，不得对外分发或商用。
