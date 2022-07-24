---
permalink: /spark/sparkshuffle
layout: default
---
## Spark Shuffle过程

这篇按编号其实应该是第六篇，为什么会先写呢……因为有人拜托了。

要讨论Shuffle过程首先要知道Shuffle是个什么操作。

网上其实相关资料并不少见，代码分析的也很透彻（当然，抄来抄去的也不少），但总觉得缺少那种“in a nutshell”的感觉。

要分析Shuffle过程，个人觉得还是按照5Ws1H的方法进行分析可能会比较清晰(Why估计估计在某些过程里会比较有难度，先放在一旁)。

## When

何时需要Shuffle？