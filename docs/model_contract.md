# PrognosOps 模型契约

> 版本:V1.0 | 日期:2026-10-22 | 状态:已确认
> 上位文档:PROJECT_RULES.md、docs/design.md
> 本文档定义特征工程与 Weibull 概率预测模块的参数、公式、单位、离散化方式与工程假设。
> 任何数值计算必须与本文档一致;公式变更必须先更新本文档。

---

## 1. 参数定义

### 1.1 特征工程参数

| 参数 | 符号 | 值 | 单位 | 说明 |
|------|------|-----|------|------|
| 特征窗口长度 | W | 30 | 周期(cycle) | 取最近 30 个周期的传感器读数 |
| 选定传感器数 | N_s | 14 | 个 | 来自 config/sensors.json,不得硬编码 |
| 特征维度 | D | 420 | 维 | D = W × N_s = 30 × 14 |
| 最少周期数 | N_min | 30 | 周期 | 单元周期数 < 30 时返回错误,不补造数据 |

**选定传感器(来自配置文件 config/sensors.json)**:
s2, s3, s4, s7, s8, s9, s11, s12, s13, s14, s15, s17, s20, s21

### 1.2 Weibull 分布参数

| 参数 | 符号 | 约束 | 单位 | 说明 |
|------|------|------|------|------|
| 尺度参数 | λ (lambda) | λ > 0 | 周期(cycle) | 特征寿命尺度,λ 越大设备平均寿命越长 |
| 形状参数 | k | k > 0 | 无量纲 | k < 1 早期故障型;k = 1 指数分布;k > 1 耗损型 |
| 位置参数 | — | 固定为 0 | — | 双参数 Weibull,不支持位置参数偏移 |

### 1.3 离散化参数

| 参数 | 符号 | 值 | 单位 | 说明 |
|------|------|-----|------|------|
| 最大离散 RUL | H | 150 | 周期(cycle) | 离散概率支撑集为 h = 0, 1, ..., 150,共 151 个点 |
| 概率向量长度 | — | 151 | 个 | P(h), h = 0..150 |

### 1.4 kNN 检索参数

| 参数 | 符号 | 默认值 | 单位 | 说明 |
|------|------|--------|------|------|
| 近邻数 | k_nn | 50 | 个 | 从参考集检索的最近邻数量 |
| 距离度量 | — | 欧氏距离 | — | 特征空间中的 L2 距离 |
| 随机种子 | seed | None(可选) | — | 固定种子保证结果可复现 |

---

## 2. 公式

### 2.1 特征提取

**输入**: 单元的传感器读数矩阵 X ∈ R^{T×14}(T 为该单元总周期数)

**步骤**:
1. 截取:取最近 W=30 行,得 X_recent ∈ R^{30×14}
   - 前提:T ≥ 30,否则返回错误(不补造)
2. 展平:按行优先展平为 420 维向量
   - f = [X_recent[0,0], X_recent[0,1], ..., X_recent[0,13], X_recent[1,0], ..., X_recent[29,13]]
3. 归一化(z-score):
   - f_norm[i] = (f[i] − μ[i]) / σ[i],i = 0..419
   - μ, σ 为归一化参数(均值与标准差,逐维度)
   - σ[i] = 0 时(常量维度),f_norm[i] = 0(约定:常量减常量为零)

### 2.2 Weibull 分布

**概率密度函数(PDF)**:
```
f(t; k, λ) = (k / λ) · (t / λ)^(k-1) · exp(-(t / λ)^k),    t ≥ 0
```

**累积分布函数(CDF)**:
```
F(t; k, λ) = 1 - exp(-(t / λ)^k),    t ≥ 0
```

**生存函数(Survival Function)** —— 本模块显式使用:
```
S(t; k, λ) = exp(-(t / λ)^k),    t ≥ 0
```

**均值与方差(参考)**:
```
E[T] = λ · Γ(1 + 1/k)
Var[T] = λ² · [Γ(1 + 2/k) - Γ²(1 + 1/k)]
```
其中 Γ 为伽马函数。

### 2.3 Weibull 极大似然估计(MLE)

给定 RUL 样本 x_1, x_2, ..., x_n(x_i > 0),对数似然函数:
```
LL(k, λ) = n·ln(k) - n·k·ln(λ) + (k-1)·Σ ln(x_i) - Σ (x_i / λ)^k
```

**求解**: 使用 scipy.stats.weibull_min.fit(samples, floc=0),固定位置参数为 0,
拟合双参数 Weibull(shape=k, scale=λ)。

**收敛判定**: 拟合结果必须满足 λ > 0 且 k > 0,否则抛出错误 E3001(拟合失败)。

### 2.4 离散化(基于生存函数)

将连续 Weibull 分布离散化为 P(RUL = h),h = 0, 1, ..., 150:

**核心公式(使用生存函数 S)**:
```
P(RUL = h) = S(h - 0.5) - S(h + 0.5),    h = 1, 2, ..., 149
P(RUL = 0) = 1 - S(0.5) = F(0.5)         # h=0 取 [0, 0.5] 区间
P(RUL = 150) = S(149.5)                   # h=150 取 [149.5, +∞) 尾部
```

推导:P(RUL = h) = F(h+0.5) − F(h−0.5) = [1−S(h+0.5)] − [1−S(h−0.5)] = S(h−0.5) − S(h+0.5)

**截断归一化**:
```
P'(h) = P(h) / Σ_{j=0}^{150} P(j),    h = 0..150
```
保证 Σ P'(h) = 1(在 [0, 150] 上截断归一)。

**累计概率(CDF)**:
```
CDF(h) = Σ_{j=0}^{h} P'(j),    h = 0..150
```

**输出前校验(强制)**: Σ P'(h) 必须等于 1(容差 1e-6),否则抛出错误。

---

## 3. 单位

| 量 | 单位 | 说明 |
|----|------|------|
| RUL(剩余使用寿命) | 周期(cycle) | FD001 数据的基本时间单位 |
| λ(尺度参数) | 周期(cycle) | 与 RUL 同单位 |
| k(形状参数) | 无量纲 | — |
| H(最大离散 RUL) | 周期(cycle) | — |
| P(h)(离散概率) | 无量纲 | 取值 [0, 1],总和为 1 |
| 特征向量 | 无量纲 | z-score 归一化后 |
| 传感器读数 | 原始物理量 | 归一化后无量纲 |

---

## 4. 离散化方式

**方法**: 区间概率近似(假设 A6)

以 [h − 0.5, h + 0.5] 区间的概率质量近似离散点 h 的概率:
- 对 h = 0,取 [0, 0.5](下界截断)
- 对 h = 1..149,取 [h−0.5, h+0.5]
- 对 h = 150,取 [149.5, +∞)(上界尾部,截断归一后吸收)

**归一化**: 在 [0, 150] 上截断归一,保证概率和严格为 1。

**输出前校验**: 概率总和与 1 的偏差超过 1e-6 时报错,不静默修正。

---

## 5. 当前工程假设

> 编号沿用设计文档 A 系列,已按本阶段用户要求更新。
> **重要变更**:原假设 A1(前向填充)已被用户要求废除,改为硬性错误。

| 编号 | 假设内容 | 状态 | 变更说明 |
|------|----------|------|----------|
| A1 | ~~周期不足 30 时用最早周期前向填充~~ → **周期不足 30 时返回错误,不补造数据** | 已变更 | 用户明确要求:数据不足 30 周期返回错误;不自动补造数据 |
| A2 | z-score 归一化参数(μ, σ)由调用方提供或从当前数据计算,逐维度独立 | 生效 | 归一化参数随特征结果一并输出,保证可追溯 |
| A3 | V1 用 kNN 基线而非训练模型 | 生效 | kNN 检索接口已实现,参考集由后续阶段构建 |
| A4 | k_nn = 50 为经验默认值,可配置 | 生效 | — |
| A5 | Weibull 参数由 MLE 从真实 RUL 样本拟合,非硬编码 | 生效 | — |
| A6 | 离散化用 [h−0.5, h+0.5] 区间概率近似,基于生存函数 S | 生效 | 显式使用 S(t) = exp(-(t/λ)^k) |
| A-F1 | 特征窗口内存在缺失值(NaN)时返回错误,不补造 | 新增 | 用户要求:不要自动补造数据 |
| A-F2 | 常量维度(σ=0)归一化后约定为 0 | 新增 | 避免除零,数学上等价于(常量−常量)/1 = 0 |
| A-W1 | 双参数 Weibull(位置参数固定为 0) | 新增 | FD001 的 RUL 从当前时点起算,无负值,位置参数无物理意义 |
| A-W2 | 离散化输出前强制校验概率归一化(容差 1e-6) | 新增 | 用户要求:输出前检查概率是否归一化 |

---

## 6. 模块接口约定

### 6.1 features.py

```python
extract_features(
    df: DataFrame,           # 含 unit/cycle/sensor 列的数值化 DataFrame
    unit_id: int,             # 目标设备单元
    normalize: bool = True,   # 是否 z-score 归一化
    norm_params: NormParams | None = None,  # 外部提供的归一化参数(保证特征空间一致)
) -> FeatureResult
```

**FeatureResult 包含**:
- feature_vector: 420 维 ndarray
- dim: 420(校验)
- window: 30
- sensors: 14 个传感器名(来自配置文件)
- sensor_mapping: 传感器名 → 特征向量中的索引范围
- norm_params: 归一化参数(μ, σ)
- assumptions: 数据假设说明列表

**错误条件**:
- 单元不存在 → E2002
- 周期数 < 30 → E3002(不补造)
- 窗口内有缺失值 → E3002(不补造)
- 维度 ≠ 420 → E3002

### 6.2 rul.py

```python
fit_weibull(
    rul_samples: ndarray,     # 正值 RUL 样本(来自 kNN 或直接标签)
    random_seed: int | None = None,  # 固定随机种子(可复现)
) -> WeibullFitResult         # lambda, k, log_likelihood

discretize_weibull(
    weibull_fit: WeibullFitResult,
    h_max: int = 150,
) -> DiscreteRULResult        # probs(151), cdf(151), h_max, is_normalized

knn_retrieve(
    query_feature: ndarray,       # 420 维查询特征
    reference_features: ndarray,  # 参考集特征矩阵 (n, 420)
    reference_ruls: ndarray,      # 参考集真实 RUL (n,)
    k: int = 50,
) -> ndarray                      # k 个最近邻的 RUL 值
```

**WeibullFitResult 包含**:
- lam: λ(尺度参数),必须 > 0
- k: 形状参数,必须 > 0
- log_likelihood: 对数似然值
- n_samples: 样本数

**DiscreteRULResult 包含**:
- probs: 151 维概率向量,Σ = 1(已校验)
- cdf: 151 维累计概率,单调递增,末项 = 1
- h_max: 150
- is_normalized: True(校验通过)

---

## 7. 维修决策模块(V1.1 新增)

> 版本:V1.1 | 日期:2026-10-22 | 状态:已确认
> 上位文档:PROJECT_RULES.md、docs/design.md 5.5 节
> 本章节定义维修决策模块的参数、公式、IEO 优化算法与工程假设。
> **重要**:默认参数以本章节为准,覆盖 design.md 5.5 节中的旧默认值。

### 7.1 决策参数

| 参数 | 符号 | 默认值 | 约束 | 单位 | 说明 |
|------|------|--------|------|------|------|
| 最小维护成本 | cm | 1 | cm > 0 | 成本单位 | 每周期最小维护成本 |
| 停机成本 | cd | 5 | cd ≥ 0 | 成本单位/周期 | 每周期停机成本 |
| 预防性更换成本 | cp | 50 | cp > 0 | 成本单位 | 计划内预防性更换成本 |
| 纠正性更换成本 | cc | 200 | cc > 0 | 成本单位 | 故障后纠正性更换成本 |
| 折现因子 | alpha | 0.01 | 0 < alpha ≤ 1 | 无量纲 | 未来成本折现,alpha 越小越重视当期 |
| 最大离散 RUL | H | 150 | H > 0 | 周期 | 与离散化模块一致 |

**派生量**:
- 运行周期成本:c_run = cm + cd(默认 6)
- 故障质量惩罚权重:w_f = (cc − cp) / max(cd, 1)(默认 (200−50)/5 = 30)

### 7.2 维修窗口集合

```
Z = {0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125}
```
共 26 个候选窗口,步长 5,范围 [0, 125]。

### 7.3 核心公式

#### 7.3.1 单次更换期望成本

对窗口 z ∈ Z,设备在到达 z 前故障(RUL < z)则执行纠正性更换(成本 cc),存活至 z 则执行预防性更换(成本 cp),运行期间每周期产生 c_run:

```
E[C1(z)] = Σ_{h=0}^{min(z-1,150)} P(h)·(cc + h·c_run) + Σ_{h=z}^{150} P(h)·(cp + z·c_run)
```

特例:z = 0 时 E[C1(0)] = cp(立即预防性更换,无运行成本)。

向量化实现:
```
h_arr = [0, 1, ..., 150]
run_cost = min(h, z) · c_run            # 运行到更换时点的成本
replace_cost = cc if h < z else cp      # 更换成本
E[C1(z)] = Σ_h P(h) · (replace_cost + run_cost)
```

#### 7.3.2 到下次更换的期望周期数

```
E[L(z)] = Σ_h P(h) · min(h, z)
```

#### 7.3.3 失效概率

```
P_fail(z) = P(RUL < z) = Σ_{h=0}^{z-1} P(h)
```
特例:z = 0 时 P_fail(0) = 0。

#### 7.3.4 单次更换期望质量

```
E[Q1(z)] = E[min(RUL, z)] − w_f · P(RUL < z)
E[min(RUL, z)] = Σ_h P(h) · min(h, z) = E[L(z)]
w_f = (cc − cp) / max(cd, 1)
```

即:E[Q1(z)] = E[L(z)] − w_f · P_fail(z)(假设 A8)。

### 7.4 四种决策策略

#### ETO-C(期望总成本最优)— 解析公式

考虑更换后设备重置、继续运行的长期期望总成本,采用更新过程两阶段近似(假设 A7):

```
E[TC(z)] = E[C1(z)] + alpha^{E[L(z)]} · V_C
V_C = min_{z'∈Z} E[C1(z')]             # 后续阶段最优单次期望成本
z*_ETO-C = argmin_{z∈Z} E[TC(z)]
```

#### ETO-Q(期望总质量最优)— 解析公式

```
E[TQ(z)] = E[Q1(z)] + alpha^{E[L(z)]} · V_Q
V_Q = max_{z'∈Z} E[Q1(z')]
z*_ETO-Q = argmax_{z∈Z} E[TQ(z)]
```

#### IEO-C(期望即时成本,经策略梯度优化)— MC + REINFORCE

以 ETO-C 的最优窗口为初始方案,通过高斯策略梯度搜索更优窗口:

**目标**:最小化 E[TC(z)](期望总成本,与 ETO-C 同目标,但 MC 估计更精确)

**MC 估计**(假设 A-D1/A-D5):对每个采样窗口 z,从 P(h) 采样 RUL 值 h_j,逐样本计算:
```
C1_j = (cc + h_j·c_run) if h_j < z else (cp + z·c_run)
L_j  = min(h_j, z)
TC_j = C1_j + alpha^{L_j} · V_C           # V_C = min E[C1(z')],解析预计算
E[TC(z)] ≈ mean(TC_j)                      # 隐含 E[alpha^L],比解析 alpha^{E[L]} 更精确
```

**算法**:
1. 初始化:μ = z*_ETO-C,σ = σ_init,baseline = None
2. 对每一步 t = 1..n_steps:
   a. 采样批量窗口:z_i ~ N(μ, σ²),i = 1..batch_size
   b. 离散化:z_i_disc = snap(z_i)(映射到 Z 中最近的候选窗口,不对此步求导,假设 A-D3)
   c. MC 总成本估计:Ĉ_i = mean(TC_j)(如上)
   d. Baseline 更新(降方差,用户要求 6):b ← decay·b + (1−decay)·mean(Ĉ_i)
   e. 优势:A_i = Ĉ_i − b
   f. Score-function 梯度(用户要求 5,不对离散窗口求导,假设 A-D3):
      g_μ = mean(A_i · (z_i − μ) / σ²)
   g. 参数更新(梯度下降,最小化成本):
      μ ← μ − lr · g_μ,并裁剪到 [min(Z), max(Z)]
      σ ← max(σ · sigma_decay, σ_min)(退火式收缩扰动范围)
3. 输出:z*_IEO-C = snap(μ_final)

#### IEO-Q(期望即时质量,经策略梯度优化)— MC + REINFORCE

以 ETO-Q 的最优窗口为初始方案,目标:最大化 E[TQ(z)](期望总质量)。

MC 估计(逐样本):
```
Q1_j = min(h_j, z) − w_f · 1{h_j < z}
TQ_j = Q1_j + alpha^{L_j} · V_Q           # V_Q = max E[Q1(z')],解析预计算
E[TQ(z)] ≈ mean(TQ_j)
```

算法同 IEO-C,区别:
- MC 估计的是总质量 TQ(而非成本 TC)
- 优势 A_i = Q̂_i − b(b 为质量的 baseline)
- 参数更新为梯度上升:μ ← μ + lr · g_μ

### 7.5 IEO 优化配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| n_steps | 100 | 训练步数 |
| batch_size | 16 | 每步采样窗口数 |
| mc_samples | 64 | 每个窗口的 MC 样本数 |
| sigma_init | 5.0 | 初始高斯标准差(约一个窗口步长,保证扰动集中在 ETO 附近) |
| sigma_min | 0.5 | 最小高斯标准差 |
| sigma_decay | 0.92 | σ 每步衰减系数 |
| lr_mu | 0.1 | μ 的学习率(小步长防过冲) |
| baseline_decay | 0.9 | baseline EMA 衰减系数 |
| random_seed | None | 随机种子(固定则可复现) |

### 7.6 与 ETO 的差额

对每个 IEO 策略,输出:
- 窗口差额:Δz = z*_IEO − z*_ETO
- 目标值差额:Δobj = obj(z*_IEO) − obj(z*_ETO)(成本为负表示改进,质量为正表示改进)

### 7.7 Regret 计算

**强制规则(规则 10)**:仅在有真实 RUL 标签时计算,否则 regret = null。

给定真实 RUL r* 与策略所选窗口 ẑ:
1. 真实成本:C_real(ẑ) = (cc + r*·c_run) 若 r* < ẑ;否则 (cp + ẑ·c_run)
2. 完美信息最优成本:C_opt = min_{z∈Z} C_real(z)
3. Regret = C_real(ẑ) − C_opt ≥ 0

### 7.8 失效概率与失效频率

- **失效概率**(决策结果内):P_fail(z*) = P(RUL < z*),对每个策略的推荐窗口输出
- **失效频率接口**:对全部候选窗口 Z 输出 P_fail(z) 曲线,即 P(RUL < z) for z ∈ Z

### 7.9 决策模块工程假设

| 编号 | 假设内容 | 状态 |
|------|----------|------|
| A7 | ETO 用"单次更换 + 折现后续最优"两阶段近似无限期更新过程,非精确迭代 | 生效 |
| A8 | 质量 Q 定义为期望正常运行周期数减去故障惩罚,w_f = (cc−cp)/max(cd,1) 为工程约定 | 生效 |
| A9 | 四策略的 ETO/IEO 区分:ETO 为解析两阶段公式;IEO 为 MC + 策略梯度优化,以 ETO 结果初始化 | 已更新 |
| A-D1 | IEO 的 MC 成本估计使用与解析公式相同的单次更换成本模型 C1(z,h),保证目标一致 | 新增 |
| A-D2 | IEO 的 σ 采用退火式衰减(非 score-function 梯度更新),保证收敛稳定性;μ 采用 score-function 梯度更新 | 新增 |
| A-D3 | 离散窗口映射 snap(z) 不参与求导:score-function 梯度基于连续高斯样本 z_i 计算,而非 snap 后的 z_i_disc | 新增 |
| A-D4 | IEO 优化结果可能与 ETO 相同(解析公式已是最优时),差额 Δz=0、Δobj≈0 属正常 | 新增 |
| A-D5 | alpha^{E[L]} 采用解析期望的幂(非 E[alpha^L]),受 Jensen 不等式影响;IEO 的 MC 估计隐含 E[alpha^L],两者可能微小差异 | 新增 |
| A-D6 | regret 的完美信息最优 C_opt = min(cp, cc + r*·c_run)(因 z=0 ∈ Z 且 cp < cc 时立即预防更换恒为最优) | 新增 |

---

## 8. 离线回测模块(V1.2 新增)

> 版本:V1.2 | 日期:2026-10-23 | 状态:已确认
> 上位文档:PROJECT_RULES.md、docs/design.md 5.6 节
> 本章节定义离线回测模块的指标、流程、数据模式区分与工程假设。

### 8.1 数据模式区分(强制)

| 模式 | 标识 | 真实 RUL | regret | NLL/MAE/校准 |
|------|------|----------|--------|--------------|
| 离线(offline) | FD001 训练集,每单元运行至故障 | 可计算:max_cycle − 当前周期 | 可计算 | 可计算 |
| 在线(online) | 上传的在线数据,无失效时间标签 | 不可知 | **恒为 null** | **恒为 null** |

真实 RUL 计算方式(仅离线模式):
```
true_rul(unit, cycle) = max_cycle(unit) − cycle
```
其中 max_cycle(unit) 为该单元数据中的最大周期号(即故障周期)。

### 8.2 回测流程

1. **构建参考集**:对每个单元,从 min_cycle 起每隔 step 个周期提取 420 维特征,
   配对真实 RUL(离线模式)或仅特征(在线模式),记录所属单元 ID;
2. **多时点决策模拟**:对每个回测单元,从 min_cycle 起每隔 step 个周期设一个决策时点:
   a. 截取该单元截至当前周期的数据,提取查询特征(最近 30 周期);
   b. kNN 检索(排除同单元样本,防数据泄露,假设 A-B1);
   c. Weibull MLE 拟合 + 离散化;
   d. 运行四策略决策;
   e. 用真实 RUL 计算 regret/NLL/MAE(离线模式);
3. **汇总指标**:跨时点聚合各策略的 regret/failure frequency/校准等;
4. **多次重复实验**:以不同随机种子重复全流程,汇总均值与标准差;
5. **成本敏感性分析**:固定 RUL 分布,变化成本参数,重新决策并计算 regret。

### 8.3 评估指标

#### 8.3.1 NLL(负对数似然)

衡量 RUL 分布估计对真实 RUL 的预测质量:
```
NLL(point) = −log f(true_rul; k, λ)
           = −[log(k) − log(λ) + (k−1)·log(true_rul/λ) − (true_rul/λ)^k]
NLL_mean = mean(NLL(point) for all points)
```
其中 f 为 Weibull PDF。true_rul ≤ 0 时跳过该点。

#### 8.3.2 MAE(平均绝对误差)

点预测精度,预测值取 Weibull 均值:
```
predicted_rul = λ · Γ(1 + 1/k)           # Weibull 均值
MAE(point) = |predicted_rul − true_rul|
MAE_mean = mean(MAE(point))
```

#### 8.3.3 Failure Frequency(观测失效频率)

各策略的实际失效发生率:
```
failure_frequency(strategy) = count(true_rul < z*_strategy) / n_points
```
仅离线模式可计算(需真实 RUL),在线模式为 null。

#### 8.3.4 Regret

沿用决策模块公式(model_contract.md 7.7 节):
```
C_real(ẑ) = (cc + r*·c_run) if r* < ẑ else (cp + ẑ·c_run)
C_opt = min_{z∈Z} C_real(z)
Regret = C_real(ẑ) − C_opt
```
在线模式:regret 恒为 null(规则 10)。

#### 8.3.5 ETO 与 IEO 差异

跨时点汇总:
- 窗口差额:Δz = z*_IEO − z*_ETO 的均值/标准差
- 目标值差额:Δobj = obj_IEO − obj_ETO 的均值/标准差
- 改进计数:IEO 优于/劣于/等于 ETO 的时点数(成本:regret 更小为优;质量:regret 更小为优)

#### 8.3.6 失效概率校准(Calibration)

检验预测失效概率与观测失效频率的一致性:
```
对每个时点:predicted = P_fail(z*_strategy),observed = 1{true_rul < z*_strategy}
分箱:B_i = [i/K, (i+1)/K),i=0..K-1,K = n_calibration_bins
每箱:mean_predicted_i = mean(predicted in B_i)
      observed_freq_i = mean(observed in B_i)
      n_i = count(predicted in B_i)
ECE = Σ_i (n_i / N) · |mean_predicted_i − observed_freq_i|
```
仅离线模式可计算,在线模式 ECE 为 null。

### 8.4 成本敏感性分析

固定各时点的离散 RUL 概率分布(不重新拟合 Weibull),
变化单个成本参数(cm/cd/cp/cc/alpha)取值,重新运行决策并计算 regret:
```
for value in sensitivity_values:
    modified_params = params with param = value
    for each point:
        decision = run_decision(probs_point, modified_params)
        regret = compute_regret(true_rul, decision.z*)
    regret_mean_by_strategy[value] = mean(regrets)
```

### 8.5 多次重复实验

以 base_seed, base_seed+1, ..., base_seed+n_repeats−1 为种子,
重复完整回测流程(Weibull 拟合与 IEO 优化受种子影响),
汇总各次实验的 NLL_mean/MAE_mean/regret_mean,输出列表与总体均值/标准差。

### 8.6 CSV 导出格式

每行对应一个回测时点 × 一个策略:
```
unit_id, cycle, true_rul, has_true_rul, lam, k, predicted_rul_mean, nll, mae_point,
strategy, chosen_window, failure_prob, objective_value, regret
```

### 8.7 回测模块工程假设

| 编号 | 假设内容 | 状态 |
|------|----------|------|
| A10 | 回测限定含真实故障时间的训练集数据;在线数据无真实标签,regret 恒为 null | 生效 |
| A-B1 | kNN 参考集采用留一单元法(leave-one-unit-out):检索时排除与查询单元相同的样本,防止数据泄露 | 新增 |
| A-B2 | 参考集时点采样步长与回测时点步长一致(均为 step),保证参考集覆盖各退化阶段 | 新增 |
| A-B3 | NLL 使用 Weibull PDF 在真实 RUL 处的负对数,衡量分布估计质量;true_rul ≤ 0 时跳过该点 | 新增 |
| A-B4 | MAE 的点预测取 Weibull 均值 λ·Γ(1+1/k),而非中位数或众数 | 新增 |
| A-B5 | 校准分箱采用等宽分箱(宽度 1/K),空箱不参与 ECE 计算 | 新增 |
| A-B6 | 敏感性分析固定 RUL 分布(不重新拟合),仅变化成本参数重新决策 | 新增 |
| A-B7 | 多次重复实验的随机性来源于 Weibull MLE 优化初值与 IEO 蒙特卡洛采样;kNN 检索本身确定性 | 新增 |
| A-B8 | 当前演示/测试数据规模可能不足以复现论文实验,结果仅用于算法验证;数据充分性说明写入报告 | 新增 |
| A-B9 | 在线模式参考集 RUL 使用数据最大周期(max_cycle)作为失效时间的近似,仅用于 kNN 检索与 Weibull 拟合,不影响测试点的 regret/NLL/MAE 评估 | 新增 |