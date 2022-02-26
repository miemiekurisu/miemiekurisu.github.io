---
permalink: /spark/task
layout: default
---
## 分析和解析任务执行过程

问题：
 - 一个Spark任务究竟是怎么执行的？


### 一个Spark任务究竟是怎么执行的

老实说，我不知道从哪里开始，
考虑到一般Spark程序通过 `spark-submit` 或 `spark-shell` 提交之后，
最终其实只会以 `write` 和 `collect` 进行实际执行，所以就从这2个函数入手。

`write`可能会比较复杂，涉及到实际存储，所以只是为了搞清楚执行过程，
还是从 `collect` 方法会比较简单。

所以我决定从一段简单的REPL代码入手：

```scala
     val firstRdd = sc.parallelize(Seq((1,2),(3,4),(5,6)))
     val secondRdd = sc.parallelize(Seq((1,'a'),(3,'b'),(5,'c')))
     firstRdd.join(secondRdd).collect
```

特意挑了一个 `join` 函数，这个函数在 `PairRDDFunctions` 里，在 `RDD` 本身代码里是找不到的。