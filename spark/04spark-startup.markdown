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

Spark standalone模式的启动脚本分别是 `./sbin/start-master.sh` 和 `./sbin/start-slave.sh`。

打开看一下，实际上是 `spark-daemon.sh` 调用了 `org.apache.spark.deploy.master.Master` ,

和 `org.apache.spark.deploy.worker.Worker` 两个主要类，其他的都是载入一些环境配置和环境变量，

最终在脚本里还是通过 `spark-class` 提交的。

### Master启动

先从 `org.apache.spark.deploy.master.Master` 开始，