---
permalink: /spark/sparkstartup
layout: default
---
## Spark集群启动过程

~~别看了，上一篇写得我眼瞎，这篇让我稍微休息两天……~~

不，我又出现了……
这次来分析一下Spark集群的启动过程，local模式没什么好说的，yarn模式是直接提交到yarn执行，
所以来看一下standalone模式。

关于yarn模式的对接，先挖个[坑](/spark/yarn)下次再说吧。

首先一切都从[官方文档](https://spark.apache.org/docs/2.4.0/spark-standalone.html)开始。
