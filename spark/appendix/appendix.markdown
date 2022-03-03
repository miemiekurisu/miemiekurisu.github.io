---
permalink: /spark/appendix/appendix
layout: default
---

## 挖代码时发现的一些有趣的地方

### CompactBuffer

### 关于`trait Product`

`Product`的子trait一直从`Product1`一直到`Product22`，

这个东西让我感到迷惑，因为`Product2`里的这一句注释：`Product2 is a cartesian product of 2 components.`。

迷惑的地方在于，最开始的地方我以为它表示一种抽象的笛卡尔积操作，所以我还在拼命找笛卡儿积实现在哪里……

找了半天没辙了，完全没有类似把 (A,B) (1,2) 转换为 (A,1)(B,1)(A,2)(B,2) 方法。

Google 了半天，看到[这里](https://stackoverflow.com/a/54623717)，其实它只是表示笛卡尔积的***结果***，于是喷了（深感scala的设计团队还能不能好好说话了……）。
